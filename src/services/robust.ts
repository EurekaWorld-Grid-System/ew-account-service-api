import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { RobustClient, RobustCreateAccount } from './types';

// Robust POST /api/user/account (OpenSim EW_UserAccountHandler): form-encoded
// first, last, email, password, password2, avatar → { IsOK, ErrorMessage, Data }.
// email is always sent empty: grid emails are a legacy feature EurekaWorld no longer uses.
// avatar is the alias Robust maps to a template avatar user (Robust's domain).

interface ActionResult {
  IsOK?: boolean;
  ErrorMessage?: string | null;
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

    let result: ActionResult | null = null;
    try {
      result = (await res.json()) as ActionResult;
    } catch {
      result = null;
    }

    if (!res.ok || result?.IsOK !== true) {
      // Robust's message is logged, never forwarded to the caller (design §6.4)
      logger.error('Robust rejected account creation', {
        first: req.first,
        last: req.last,
        status: res.status,
        robustError: result?.ErrorMessage ?? null,
      });
      throw new AppError(502, 'REGISTRATION_FAILED', 'Grid account creation failed');
    }
  }
}
