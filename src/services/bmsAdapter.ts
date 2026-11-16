import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { BmsAdapterClient, BmsCreatedUser, BmsCreateUser, BmsUserRef, Credentials } from './types';

// bms-adapter (internal, X-Api-Key). Response envelope:
// { success, message, code, data } with the HTTP status mapped from code (400/404/409, ...).

interface Envelope<T> {
  success?: boolean;
  code?: string | null;
  errorCode?: string | null; // legacy field name, still sent by some endpoints
  message?: string | null;
  data?: T | null;
}

interface Reply<T> {
  status: number;
  body: Envelope<T> | null;
}

/** bms-adapter's PASSWORD_REUSED is the system's PASSWORD_RECENTLY_USED. */
function isReuseCode(code: string | null | undefined): boolean {
  return code === 'PASSWORD_REUSED' || code === 'PASSWORD_RECENTLY_USED';
}

export class HttpBmsAdapterClient implements BmsAdapterClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number
  ) {}

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    opts: { body?: unknown; user?: BmsUserRef; headers?: Record<string, string>; failCode: string; op: string }
  ): Promise<Reply<T>> {
    const headers: Record<string, string> = { 'X-Api-Key': this.apiKey, ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.user) {
      headers['X-Organization'] = opts.user.organization;
      headers['X-Institute-Id'] = opts.user.instituteId;
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const name = (err as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        logger.error('bms-adapter timed out', { op: opts.op, timeoutMs: this.timeoutMs });
        throw new AppError(504, 'BMS_ADAPTER_TIMEOUT', 'bms-adapter did not answer in time');
      }
      logger.error('bms-adapter unreachable', { op: opts.op, error: (err as Error).message });
      throw new AppError(502, opts.failCode, 'bms-adapter request failed');
    }

    let body: Envelope<T> | null = null;
    try {
      body = (await res.json()) as Envelope<T>;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  private fail(op: string, reply: Reply<unknown>, failCode: string, ctx: object = {}): AppError {
    logger.error('bms-adapter request failed', {
      op,
      ...ctx,
      status: reply.status,
      code: reply.body?.code ?? reply.body?.errorCode ?? null,
      message: reply.body?.message ?? null,
    });
    return new AppError(502, failCode, 'bms-adapter request failed');
  }

  // ── POST /users (v39.8): BMS user + ew_index account_index/user_index ────────
  async createUser(req: BmsCreateUser): Promise<BmsCreatedUser> {
    const reply = await this.request<Partial<BmsCreatedUser>>('POST', '/users', {
      op: 'createUser',
      failCode: 'BMS_REGISTRATION_FAILED',
      user: { userId: '', organization: req.organization, instituteId: req.instituteId },
      // Portal self-registration always creates regular users
      headers: { 'X-Registrant-Type': 'User' },
      body: {
        username: req.username,
        firstName: req.firstName,
        lastName: req.lastName,
        password: req.password,
        email: req.email,
        openSimUserId: req.openSimUserId,
        licenseId: req.licenseId,
      },
    });
    const data = reply.body?.data;
    if (reply.status !== 201 || !reply.body?.success || !data || typeof data.userId !== 'string') {
      throw this.fail('createUser', reply, 'BMS_REGISTRATION_FAILED', { username: req.username });
    }
    return {
      userId: data.userId,
      username: typeof data.username === 'string' ? data.username : req.username,
      accountId: typeof data.accountId === 'string' ? data.accountId : null,
      indexWriteSucceeded: data.indexWriteSucceeded === true,
    };
  }

  // ── Passwords (Pre-Launch Security Design §1; the same calls ew-portal-api makes) ──
  async getCredentials(user: BmsUserRef): Promise<Credentials | null> {
    const reply = await this.request<Partial<Credentials>>(
      'GET',
      `/users/${encodeURIComponent(user.userId)}/credentials`,
      { op: 'getCredentials', failCode: 'BMS_ADAPTER_UNAVAILABLE', user }
    );
    if (reply.status === 404) return null;
    const d = reply.body?.data;
    if (reply.status !== 200 || !reply.body?.success || typeof d?.hashCode !== 'string' || typeof d?.salt !== 'string') {
      throw this.fail('getCredentials', reply, 'BMS_ADAPTER_UNAVAILABLE', { userId: user.userId });
    }
    return {
      hashCode: d.hashCode,
      salt: d.salt,
      isInitial: d.isInitial === true,
      globalRole: typeof d.globalRole === 'string' ? d.globalRole : 'User',
      hasMfa: d.hasMfa === true,
      mfaIsInitial: d.mfaIsInitial === true,
    };
  }

  // ── Login (copied from ew-portal-api) and MFA (bms-adapter v39.10) ──────────
  async migrateByUsername(username: string): Promise<boolean> {
    const reply = await this.request<{ status?: string }>('POST', '/users/migrate-by-username', {
      op: 'migrateByUsername',
      failCode: 'BMS_ADAPTER_UNAVAILABLE',
      body: { username },
    });
    if (reply.status === 200 && reply.body?.success) {
      logger.info('Login: BmsLoginFallback migration', { username, status: reply.body.data?.status ?? null });
      return true;
    }
    // 404 = not in BMS / back-fill disabled; 500/501 = migration failed: the login falls through to 401
    const code = reply.body?.code ?? reply.body?.errorCode ?? null;
    if (reply.status === 404) logger.debug('Login: BmsLoginFallback found nothing', { username, code });
    else logger.warn('Login: BmsLoginFallback migration failed', { username, status: reply.status, code });
    return false;
  }

  async getMfa(user: BmsUserRef): Promise<{ authCode: string; lastVerificationOn: string | null } | null> {
    const reply = await this.request<{ authCode?: string; lastVerificationOn?: string | null }>(
      'GET',
      `/users/${encodeURIComponent(user.userId)}/mfa`,
      { op: 'getMfa', failCode: 'BMS_ADAPTER_UNAVAILABLE', user }
    );
    if (reply.status === 404) return null;
    const d = reply.body?.data;
    // Never log the body here: it carries the TOTP secret
    if (reply.status !== 200 || !reply.body?.success || typeof d?.authCode !== 'string' || d.authCode === '') {
      throw this.fail('getMfa', { status: reply.status, body: { code: reply.body?.code ?? null } }, 'BMS_ADAPTER_UNAVAILABLE', {
        userId: user.userId,
      });
    }
    return { authCode: d.authCode, lastVerificationOn: typeof d.lastVerificationOn === 'string' ? d.lastVerificationOn : null };
  }

  async markMfaVerified(user: BmsUserRef): Promise<void> {
    const reply = await this.request<unknown>('POST', `/users/${encodeURIComponent(user.userId)}/mfa/verify`, {
      op: 'markMfaVerified',
      failCode: 'BMS_ADAPTER_UNAVAILABLE',
      user,
    });
    if (reply.status === 200 && reply.body?.success) return;
    throw this.fail('markMfaVerified', reply, 'BMS_ADAPTER_UNAVAILABLE', { userId: user.userId });
  }

  async computeHash(password: string, salt: string): Promise<string> {
    const reply = await this.request<{ hash?: string }>('POST', '/users/compute-hash', {
      op: 'computeHash',
      failCode: 'BMS_ADAPTER_UNAVAILABLE',
      body: { password, salt },
    });
    const hash = reply.body?.data?.hash;
    if (reply.status !== 200 || !reply.body?.success || typeof hash !== 'string') {
      throw this.fail('computeHash', reply, 'BMS_ADAPTER_UNAVAILABLE');
    }
    return hash;
  }

  async isPasswordAllowed(user: BmsUserRef, newPassword: string): Promise<boolean> {
    const reply = await this.request<unknown>('POST', `/users/${encodeURIComponent(user.userId)}/password/validate`, {
      op: 'validatePassword',
      failCode: 'BMS_ADAPTER_UNAVAILABLE',
      user,
      body: { newPassword },
    });
    if (reply.status === 200 && reply.body?.success) return true;
    if (reply.status === 400 && isReuseCode(reply.body?.code ?? reply.body?.errorCode)) return false;
    throw this.fail('validatePassword', reply, 'BMS_ADAPTER_UNAVAILABLE', { userId: user.userId });
  }

  async setPassword(user: BmsUserRef, newPassword: string, isInitial: boolean): Promise<void> {
    const reply = await this.request<unknown>('PUT', `/users/${encodeURIComponent(user.userId)}/password`, {
      op: 'setPassword',
      failCode: 'BMS_ADAPTER_UNAVAILABLE',
      user,
      body: { newPassword, isInitial },
    });
    if (reply.status === 200 && reply.body?.success) return;
    if (reply.status === 400 && isReuseCode(reply.body?.code ?? reply.body?.errorCode)) {
      throw new AppError(400, 'PASSWORD_RECENTLY_USED', 'This password was used recently');
    }
    throw this.fail('setPassword', reply, 'BMS_ADAPTER_UNAVAILABLE', { userId: user.userId });
  }
}
