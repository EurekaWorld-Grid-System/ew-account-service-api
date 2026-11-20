import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger';
import type { LoginDeps, LoginReply } from './login';
import { AccessTokenClaims, VerifiedAccessToken } from './tokens';
import { Organization } from './types';

// POST /auth/refresh, POST /auth/logout (copied from ew-portal-api routes/auth.ts) and
// POST /auth/verify (ew-portal-api middleware/auth.ts requireAuth), with server-side sessions
// (ew_system.auth_sessions, db/ew_system_auth_sessions.sql):
//
//   refresh  verify the cookie's refresh token → user_index lookup → BMS credentials (fresh
//            globalRole / isInitial, as in ew-portal-api) → rotate the session's jti atomically →
//            new access token + new refresh cookie. A jti older than the current one means the
//            refresh token was copied: the session is revoked. Exception: the previous jti within
//            REFRESH_GRACE_SECONDS of a rotation (two tabs refreshing at once) gets tokens for the
//            current jti instead. The jti is rotated last, so a BMS or database failure before it
//            (503) leaves the session as it was and the user can retry.
//   verify   access token signature/expiry/type (as requireAuth) + its session is still active
//   logout   access token as requireAuth; revokes its session and clears the cookie
//
// Tokens without sid (issued before 0.5.0, or by ew-portal-api itself) have no session: refresh
// and verify reject them, so every user logs in once after the switch.

export const REFRESH_GRACE_SECONDS = 60;

export type SessionDeps = Pick<LoginDeps, 'index' | 'bms' | 'system' | 'tokens'>;

const fail = (status: number, code: string, message: string, clearRefreshCookie = false): LoginReply => ({
  status,
  body: { code, message },
  ...(clearRefreshCookie && { clearRefreshCookie }),
});

export async function refresh(deps: SessionDeps, token: string | undefined): Promise<LoginReply> {
  if (!token) return fail(401, 'TOKEN_INVALID', 'No refresh token');

  let decoded;
  try {
    decoded = deps.tokens.verifyRefreshToken(token);
  } catch (e) {
    return (e as Error)?.name === 'TokenExpiredError'
      ? fail(401, 'TOKEN_EXPIRED', 'Refresh token expired', true)
      : fail(401, 'TOKEN_INVALID', 'Invalid refresh token', true);
  }
  if (decoded.type !== 'refresh') return fail(401, 'TOKEN_INVALID', 'Invalid token type');
  const { sub: userId, sid, jti } = decoded;
  if (!sid || !jti) {
    logger.info('Refresh: token has no session (issued before 0.5.0); login needed', { userId });
    return fail(401, 'TOKEN_INVALID', 'Session not found', true);
  }

  const notFound = async (): Promise<LoginReply> => {
    await deps.system.revokeSession(sid, 'user-not-found');
    return fail(401, 'TOKEN_INVALID', 'User not found', true);
  };

  const user = await deps.index.findSessionUser(userId);
  if (!user) return notFound();
  const organization = user.organization === 'both' ? 'general' : user.organization;
  const credentials = await deps.bms.getCredentials({
    userId: user.userId,
    organization: organization as Organization,
    instituteId: user.instituteId,
  });
  if (!credentials) return notFound();

  const newJti = randomUUID();
  const next = deps.tokens.signRefreshToken(user.userId, sid, newJti);
  const rotation = await deps.system.rotateSession(sid, jti, newJti, next.ttlSeconds, REFRESH_GRACE_SECONDS);

  if ((rotation.result !== 'OK' && rotation.result !== 'GRACE') || rotation.userId !== user.userId || !rotation.refreshJti) {
    if (rotation.result === 'REUSED') {
      logger.warn('Refresh: old refresh token presented again; session revoked', { userId, sessionId: sid });
    } else {
      logger.info('Refresh rejected', { userId, sessionId: sid, result: rotation.result });
    }
    const message = rotation.result === 'EXPIRED' ? 'Session expired' : rotation.result === 'NOT_FOUND' ? 'Session not found' : 'Session revoked';
    return fail(401, rotation.result === 'EXPIRED' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID', message, true);
  }

  const refreshToken = rotation.result === 'OK' ? next.token : deps.tokens.signRefreshToken(user.userId, sid, rotation.refreshJti).token;

  const claims: AccessTokenClaims & { sid: string } = {
    sub: user.userId,
    accountId: user.accountId,
    username: user.username, // from account_index, as in ew-portal-api
    globalRole: credentials.globalRole.toLowerCase(),
    organization,
    instituteId: user.instituteId,
    isInitial: credentials.isInitial,
    sid,
  };
  return { status: 200, body: { accessToken: deps.tokens.signAccessToken(claims) }, refreshToken };
}

/** Bearer access token, verified as ew-portal-api requireAuth does (401 reply on failure). */
function bearer(deps: SessionDeps, authorization: string | undefined): VerifiedAccessToken | LoginReply {
  if (!authorization?.startsWith('Bearer ')) return fail(401, 'TOKEN_INVALID', 'Missing or invalid Authorization header');
  try {
    return deps.tokens.verifyAccessToken(authorization.slice(7));
  } catch (e) {
    return (e as Error)?.name === 'TokenExpiredError'
      ? fail(401, 'TOKEN_EXPIRED', 'Access token expired')
      : fail(401, 'TOKEN_INVALID', 'Invalid token');
  }
}

const isReply = (v: VerifiedAccessToken | LoginReply): v is LoginReply => 'status' in v && 'body' in v;

/** 200 { claims } (the access token's payload: what ew-portal-api puts in req.user). */
export async function verify(deps: SessionDeps, authorization: string | undefined): Promise<LoginReply> {
  const claims = bearer(deps, authorization);
  if (isReply(claims)) return claims;
  if (!claims.sid) return fail(401, 'TOKEN_INVALID', 'Session not found');
  if (!(await deps.system.isSessionActive(claims.sid))) return fail(401, 'TOKEN_INVALID', 'Session revoked');
  return { status: 200, body: { claims } };
}

export async function logout(deps: SessionDeps, authorization: string | undefined): Promise<LoginReply> {
  const claims = bearer(deps, authorization);
  if (isReply(claims)) return claims;
  if (claims.sid) await deps.system.revokeSession(claims.sid, 'logout');
  return { status: 200, body: { message: 'Logged out' }, clearRefreshCookie: true };
}
