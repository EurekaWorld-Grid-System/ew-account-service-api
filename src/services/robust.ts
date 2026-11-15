import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { RobustClient, RobustCreateAccount } from './types';

// Registration Robust, EurekaWorld EW API (OpenSim EW_RobustApiServiceConnector). Both calls are
// form-encoded and answer { IsOK, ErrorMessage, Data } (HTTP 200 for success and handled errors).
// - POST /api/user/account (EW_UserAccountHandler): first, last, email, password, password2, avatar.
//   email is always sent empty: grid emails are a legacy feature EurekaWorld no longer uses.
//   avatar is the alias Robust maps to a template avatar user (Robust's domain).
// - POST /api/password/<PrincipalID> (EW_PasswordHandler): password. Rewrites the grid auth row
//   only. It doesn't check that the user exists, so callers check first (opensim-build-01).

interface ActionResult {
  isOk: boolean | null;
  errorMessage: string | null;
}

/** Robust's OSDMap JSON, read with case-insensitive keys; null when the body isn't a JSON object. */
export function parseActionResult(text: string): ActionResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const get = (key: string): unknown => {
    const k = Object.keys(parsed as object).find(x => x.toLowerCase() === key);
    return k === undefined ? undefined : (parsed as Record<string, unknown>)[k];
  };
  const ok = get('isok');
  const msg = get('errormessage');
  return {
    isOk: typeof ok === 'boolean' ? ok : typeof ok === 'string' ? ok.toLowerCase() === 'true' : null,
    errorMessage: typeof msg === 'string' && msg !== '' ? msg : null,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class HttpRobustClient implements RobustClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number
  ) {}

  /** POST a form to Robust; resolves when IsOK is true, otherwise logs and throws AppError(502, failCode). */
  private async post(path: string, form: Record<string, string>, failCode: string, failMessage: string, logCtx: object) {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        // URLSearchParams percent-encodes & and =, which Robust's parser would otherwise split on
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const name = (err as Error).name;
      logger.error('Robust call failed: no response', {
        ...logCtx,
        url,
        error: name === 'TimeoutError' ? `timeout after ${this.timeoutMs} ms` : (err as Error).message,
      });
      throw new AppError(502, failCode, failMessage);
    }

    let text = '';
    try {
      text = await res.text();
    } catch {
      text = '';
    }
    const result = parseActionResult(text);

    if (!res.ok || result?.isOk !== true) {
      // Robust's message is logged, never forwarded to the caller. When the body isn't Robust's JSON
      // result (e.g. wrong port/path: the EW API connector isn't loaded there), log what came back.
      logger.error('Robust rejected the request', {
        ...logCtx,
        url,
        status: res.status,
        contentType: res.headers.get('content-type'),
        robustError: result?.errorMessage ?? null,
        ...(result ? {} : { body: text.slice(0, 500) }),
      });
      throw new AppError(502, failCode, failMessage);
    }
  }

  async createAccount(req: RobustCreateAccount): Promise<void> {
    await this.post(
      '/api/user/account',
      { first: req.first, last: req.last, email: '', password: req.password, password2: req.password, avatar: req.avatar },
      'REGISTRATION_FAILED',
      'Grid account creation failed',
      { op: 'createAccount', first: req.first, last: req.last }
    );
  }

  async setPassword(principalId: string, password: string): Promise<void> {
    // A malformed id makes Robust fail outside its JSON contract; never send one
    if (!UUID_RE.test(principalId)) {
      logger.error('Grid password sync skipped: malformed PrincipalID', { principalId });
      throw new AppError(502, 'GRID_PASSWORD_SYNC_FAILED', 'Grid password update failed');
    }
    await this.post(
      `/api/password/${principalId.toLowerCase()}`,
      { password },
      'GRID_PASSWORD_SYNC_FAILED',
      'Grid password update failed',
      { op: 'setPassword', principalId }
    );
  }
}
