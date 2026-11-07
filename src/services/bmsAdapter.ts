import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { BmsAdapterClient, BmsCreatedUser, BmsCreateUser } from './types';

// bms-adapter POST /users (v39.8): creates the BMS user records atomically, then writes
// ew_index account_index + user_index (with open_sim_user_id). Envelope:
// { success, message, code, data: { userId, username, accountId, indexWriteSucceeded } }.

interface Envelope {
  success?: boolean;
  code?: string | null;
  message?: string | null;
  data?: Partial<BmsCreatedUser> | null;
}

export class HttpBmsAdapterClient implements BmsAdapterClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number
  ) {}

  async createUser(req: BmsCreateUser): Promise<BmsCreatedUser> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': this.apiKey,
          'X-Organization': req.organization,
          'X-Institute-Id': req.instituteId,
          // Portal self-registration always creates regular users
          'X-Registrant-Type': 'User',
        },
        body: JSON.stringify({
          username: req.username,
          firstName: req.firstName,
          lastName: req.lastName,
          password: req.password,
          email: req.email,
          openSimUserId: req.openSimUserId,
          licenseId: req.licenseId,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const name = (err as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        logger.error('bms-adapter POST /users timed out', { timeoutMs: this.timeoutMs, username: req.username });
        throw new AppError(504, 'BMS_ADAPTER_TIMEOUT', 'bms-adapter did not answer in time');
      }
      logger.error('bms-adapter POST /users unreachable', { error: (err as Error).message, username: req.username });
      throw new AppError(502, 'BMS_REGISTRATION_FAILED', 'BMS user creation failed');
    }

    let body: Envelope | null = null;
    try {
      body = (await res.json()) as Envelope;
    } catch {
      body = null;
    }

    const data = body?.data;
    if (res.status !== 201 || !body?.success || !data || typeof data.userId !== 'string') {
      logger.error('bms-adapter POST /users failed', {
        status: res.status,
        code: body?.code ?? null,
        message: body?.message ?? null,
        username: req.username,
      });
      throw new AppError(502, 'BMS_REGISTRATION_FAILED', 'BMS user creation failed');
    }

    return {
      userId: data.userId,
      username: typeof data.username === 'string' ? data.username : req.username,
      accountId: typeof data.accountId === 'string' ? data.accountId : null,
      indexWriteSucceeded: data.indexWriteSucceeded === true,
    };
  }
}
