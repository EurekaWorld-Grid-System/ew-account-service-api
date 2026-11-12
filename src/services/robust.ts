import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { RobustClient, RobustCreateAccount } from './types';

// Robust POST /api/user/account (OpenSim EW_UserAccountHandler): form-encoded
// first, last, email, password, password2, avatar → { IsOK, ErrorMessage, Data }.
// email is always sent empty: grid emails are a legacy feature EurekaWorld no longer uses.
// avatar is the alias Robust maps to a template avatar user (Robust's domain).

interface ActionResult {
  isOk: boolean | null;
  errorMessage: string | null;
}

/** Robust's OSDMap JSON, read with case-insensitive keys; null when the body isn't a JSON object. */
export function parseActionResult(text: string): ActionResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
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

export class HttpRobustClient implements RobustClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number
  ) {}

  async createAccount(req: RobustCreateAccount): Promise<void> {
    const body = new URLSearchParams({
      first: req.first,
      last: req.last,
      email: '',
      password: req.password,
      password2: req.password,
      avatar: req.avatar,
    });

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/user/account`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const name = (err as Error).name;
      logger.error('Robust account creation failed: no response', {
        first: req.first,
        last: req.last,
        error: name === 'TimeoutError' ? `timeout after ${this.timeoutMs} ms` : (err as Error).message,
      });
      throw new AppError(502, 'REGISTRATION_FAILED', 'Grid account creation failed');
    }

    let text = '';
    try {
      text = await res.text();
    } catch {
      text = '';
    }
    const result = parseActionResult(text);

    if (!res.ok || result?.isOk !== true) {
      // Robust's message is logged, never forwarded to the caller (design §6.4).
      // When the body isn't Robust's JSON result (e.g. wrong port/path), log what came back.
      logger.error('Robust rejected account creation', {
        first: req.first,
        last: req.last,
        url: `${this.baseUrl}/api/user/account`,
        status: res.status,
        contentType: res.headers.get('content-type'),
        robustError: result?.errorMessage ?? null,
        ...(result ? {} : { body: text.slice(0, 500) }),
      });
      throw new AppError(502, 'REGISTRATION_FAILED', 'Grid account creation failed');
    }
  }
}
