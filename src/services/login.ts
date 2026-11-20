import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger';
import { LoginGuard, MfaGuard } from './loginGuard';
import { TokenIssuer } from './tokens';
import { otpauthUri, qrPng, TOTP_RE, verifyTotp } from './totp';
import { BmsAdapterClient, BmsUserRef, Credentials, IndexRepository, LoginUser, Organization, SystemRepository } from './types';

// POST /auth/login, copied from ew-portal-api (routes/auth.ts) and extended with MFA (Asaff,
// 2026-11-16), plus POST /auth/mfa/qr for MFA initialisation.
//
// Login steps (as in ew-portal-api): rate limit → captcha (after 3 failures) → user_index lookup
// (+ BmsLoginFallback) → BMS credentials → password hash. Then, new:
//   hasMfa && no mfaToken          → 200 { status: 'MFA_REQUIRED' } (or 'MFA_INITIAL' while the
//                                    secret was never verified); no tokens
//   hasMfa && mfaToken             → TOTP check on the BMS secret; on success bms-adapter marks it
//                                    verified (LastVerificationOn; ends the initial state)
//   then (or without MFA)          → access token + refresh cookie, same shape as ew-portal-api,
//                                    in a new server-side session (0.5.0, services/session.ts).
// Every request counts against the rate limit. A correct password resets the login counters (so the
// MFA step and the QR request need no captcha: Asaff, 2026-11-20); wrong MFA codes have their own
// per-user limit (MfaGuard: 5 per 15 minutes → 429 RATE_LIMITED).

export interface LoginDeps {
  index: IndexRepository;
  bms: BmsAdapterClient;
  /** ew_system: login sessions */
  system: SystemRepository;
  guard: LoginGuard;
  /** wrong 6-digit codes per user */
  mfaGuard: MfaGuard;
  verifyCaptcha: (token: string) => Promise<boolean>;
  tokens: TokenIssuer;
  bmsLoginFallback: boolean;
}

export interface LoginInput {
  username: unknown;
  password: unknown;
  captchaToken?: unknown;
  mfaToken?: unknown;
  ip: string;
}

/** An HTTP answer: the route sends it as is (plus the refresh cookie when present). */
export interface LoginReply {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  refreshToken?: string;
  clearRefreshCookie?: boolean;
}

interface Authenticated {
  user: LoginUser;
  bmsUser: BmsUserRef;
  organization: string;
  credentials: Credentials;
  key: string;
}

const err = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): LoginReply => ({
  status,
  body: { code, message, ...extra },
});

/** Steps 1-6: everything up to a verified password. Returns a reply to send on any failure. */
async function authenticate(deps: LoginDeps, input: LoginInput): Promise<Authenticated | LoginReply> {
  const username = typeof input.username === 'string' ? input.username.trim() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  if (!username) return err(400, 'VALIDATION_ERROR', 'Username is required');
  if (!password) return err(400, 'VALIDATION_ERROR', 'Password is required');

  const key = deps.guard.deriveKey(username, input.ip);

  // 1 — rate limit
  const check = deps.guard.checkGuard(key);
  if (check.blocked) {
    return {
      ...err(429, 'RATE_LIMITED', 'Too many requests. Try again later.'),
      headers: { 'Retry-After': String(Math.ceil((check.retryAfterMs ?? 0) / 1000)) },
    };
  }

  // 2 — captcha
  if (check.requiresCaptcha) {
    const captchaToken = typeof input.captchaToken === 'string' ? input.captchaToken : '';
    if (!captchaToken) return err(400, 'CAPTCHA_REQUIRED', 'CAPTCHA required', { requiresCaptcha: true });
    if (!(await deps.verifyCaptcha(captchaToken))) return err(400, 'INVALID_CAPTCHA', 'CAPTCHA verification failed');
  }

  deps.guard.recordAttempt(key);

  const invalid = (): LoginReply => {
    deps.guard.recordFailure(key);
    return err(401, 'INVALID_CREDENTIALS', 'Invalid username or password', {
      ...(deps.guard.getFailureCount(key) >= 3 && { requiresCaptcha: true }),
    });
  };

  // 3 — user_index ⋈ account_index; 3b — BmsLoginFallback (on-demand migration) then one retry
  let user = await deps.index.findLoginUser(username);
  if (!user && deps.bmsLoginFallback) {
    if (await deps.bms.migrateByUsername(username)) user = await deps.index.findLoginUser(username);
    if (!user) logger.debug('Login: user not found after BmsLoginFallback', { username });
  }
  if (!user) return invalid();

  // 4 — organization ('both' is deprecated → 'general')
  const organization = user.organization === 'both' ? 'general' : user.organization;
  const bmsUser: BmsUserRef = { userId: user.userId, organization: organization as Organization, instituteId: user.instituteId };

  // 5 — credentials; 6 — password (bms-adapter computes the hash)
  const credentials = await deps.bms.getCredentials(bmsUser);
  if (!credentials) return invalid();
  const hash = await deps.bms.computeHash(password, credentials.salt);
  if (hash !== credentials.hashCode) return invalid();

  // The username and password are proven: reset the counters (no captcha on the next step)
  deps.guard.recordSuccess(key);
  return { user, bmsUser, organization, credentials, key };
}

const isReply = (v: Authenticated | LoginReply): v is LoginReply => 'status' in v && 'body' in v;

export async function login(deps: LoginDeps, input: LoginInput): Promise<LoginReply> {
  const auth = await authenticate(deps, input);
  if (isReply(auth)) return auth;
  const { user, bmsUser, organization, credentials } = auth;

  // 7 — MFA
  if (credentials.hasMfa) {
    const status = credentials.mfaIsInitial ? 'MFA_INITIAL' : 'MFA_REQUIRED';
    const mfaToken = typeof input.mfaToken === 'string' ? input.mfaToken.trim() : '';
    if (!mfaToken) return { status: 200, body: { status } };

    const mfaCheck = deps.mfaGuard.check(user.userId);
    if (mfaCheck.blocked) {
      logger.warn('Login: MFA code limit reached', { userId: user.userId });
      return {
        ...err(429, 'RATE_LIMITED', 'Too many authentication codes. Try again later.', { status }),
        headers: { 'Retry-After': String(Math.ceil((mfaCheck.retryAfterMs ?? 0) / 1000)) },
      };
    }

    const mfa = await deps.bms.getMfa(bmsUser);
    if (!mfa) {
      // UseDoubleAuth is set but there's no active DoubleAuths row: needs an admin
      logger.error('Login: MFA enabled but no active secret', { userId: user.userId, accountId: user.accountId });
      return err(409, 'MFA_NOT_AVAILABLE', 'MFA is not set up for this account; contact support');
    }
    // While initial, LastVerificationOn is NULL: no replay window to apply
    if (!TOTP_RE.test(mfaToken) || !verifyTotp(mfaToken, mfa.authCode, credentials.mfaIsInitial ? null : mfa.lastVerificationOn)) {
      deps.mfaGuard.recordFailure(user.userId);
      logger.warn('Login: invalid MFA token', { userId: user.userId, status });
      return err(401, 'INVALID_MFA_TOKEN', 'Invalid authentication code', { status });
    }
    deps.mfaGuard.reset(user.userId);
    await deps.bms.markMfaVerified(bmsUser);
    if (credentials.mfaIsInitial) logger.info('Login: MFA initialised', { userId: user.userId, accountId: user.accountId });
  }

  // 8 — success (globalRole already resolved by bms-adapter): a new session
  const sessionId = randomUUID();
  const refreshJti = randomUUID();
  const refresh = deps.tokens.signRefreshToken(user.userId, sessionId, refreshJti);
  await deps.system.createSession({
    sessionId,
    userId: user.userId,
    refreshJti,
    ttlSeconds: refresh.ttlSeconds,
    clientIp: input.ip === 'unknown' ? null : input.ip,
  });
  const globalRole = credentials.globalRole.toLowerCase();
  const claims = {
    sub: user.userId,
    accountId: user.accountId,
    username: user.username,
    globalRole,
    organization,
    instituteId: user.instituteId,
    isInitial: credentials.isInitial,
  };
  return {
    status: 200,
    body: {
      accessToken: deps.tokens.signAccessToken({ ...claims, sid: sessionId }),
      user: {
        userId: user.userId,
        accountId: user.accountId,
        username: user.username,
        globalRole,
        organization,
        instituteId: user.instituteId,
        isInitial: credentials.isInitial,
      },
    },
    refreshToken: refresh.token,
  };
}

/** POST /auth/mfa/qr: the QR (PNG) of the user's never-verified secret, after the same password checks. */
export async function mfaQr(deps: LoginDeps, input: LoginInput): Promise<LoginReply | { png: Buffer }> {
  const auth = await authenticate(deps, input);
  if (isReply(auth)) return auth;
  const { user, bmsUser, credentials } = auth;

  // Only before the first successful verification: a verified authenticator can't be copied later
  if (!credentials.hasMfa || !credentials.mfaIsInitial) {
    return err(409, 'MFA_NOT_INITIAL', 'MFA is not awaiting initialisation for this account');
  }
  const mfa = await deps.bms.getMfa(bmsUser);
  if (!mfa) {
    logger.error('MFA QR: MFA enabled but no active secret', { userId: user.userId, accountId: user.accountId });
    return err(409, 'MFA_NOT_AVAILABLE', 'MFA is not set up for this account; contact support');
  }
  logger.info('MFA QR issued', { userId: user.userId, accountId: user.accountId });
  return { png: await qrPng(otpauthUri(user.username, mfa.authCode)) };
}
