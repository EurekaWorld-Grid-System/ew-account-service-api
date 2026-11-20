import mysql, { Pool, RowDataPacket } from 'mysql2/promise';
import { DbConfig } from '../config';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import {
  CouponInfo,
  GridName,
  GridRepository,
  IndexedUser,
  IndexRepository,
  LoginUser,
  NewSession,
  Organization,
  SessionRotation,
  SessionRotationResult,
  ServiceToken,
  SystemRepository,
} from './types';

// Three pools on the same Aurora cluster and database user, different databases:
// ew_index and the OpenSim grid DB (SELECT only, design §4), ew_system (EXECUTE on its routines).
function createPool(cfg: DbConfig, database: string): Pool {
  return mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database,
    connectionLimit: 5,
    connectTimeout: cfg.timeoutMs,
    waitForConnections: true,
    queueLimit: 50,
    enableKeepAlive: true,
  });
}

type DbCode = 'GRID_DB_UNAVAILABLE' | 'INDEX_DB_UNAVAILABLE' | 'SYSTEM_DB_UNAVAILABLE';
const DB_NAMES: Record<DbCode, string> = {
  GRID_DB_UNAVAILABLE: 'Grid database unavailable',
  INDEX_DB_UNAVAILABLE: 'Index database unavailable',
  SYSTEM_DB_UNAVAILABLE: 'System database unavailable',
};

function dbFailure(code: DbCode, err: unknown): AppError {
  // Log the driver's error code/message only: never SQL parameters
  const e = err as { code?: string; message?: string };
  logger.error('Database query failed', { code, dbErrorCode: e.code, dbMessage: e.message });
  return new AppError(503, code, DB_NAMES[code]);
}

export class MysqlIndexRepository implements IndexRepository {
  constructor(
    private readonly pool: Pool,
    private readonly timeoutMs: number
  ) {}

  private async rows(sql: string, values: unknown[]): Promise<RowDataPacket[]> {
    try {
      const [rows] = await this.pool.query<RowDataPacket[]>({ sql, values, timeout: this.timeoutMs });
      return rows;
    } catch (err) {
      throw dbFailure('INDEX_DB_UNAVAILABLE', err);
    }
  }

  async findCoupon(couponCode: string): Promise<CouponInfo | null> {
    // license_index has no active flag: a coupon is valid when it is in the index
    const rows = await this.rows(
      'SELECT li.license_id, li.institute_id, ii.name, ii.organization ' +
        'FROM license_index li JOIN institute_index ii ON ii.institute_id = li.institute_id ' +
        'WHERE li.coupon_code = ? LIMIT 1',
      [couponCode]
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      licenseId: String(r.license_id),
      instituteId: String(r.institute_id),
      instituteName: String(r.name),
      organization: String(r.organization) as Organization,
    };
  }

  async emailExists(email: string): Promise<boolean> {
    // account_index collation is case-insensitive
    const rows = await this.rows('SELECT 1 FROM account_index WHERE email = ? LIMIT 1', [email]);
    return rows.length > 0;
  }

  async usernameExists(username: string): Promise<boolean> {
    const rows = await this.rows(
      'SELECT 1 FROM account_index WHERE username = ? ' +
        'UNION ALL SELECT 1 FROM user_index WHERE username = ? LIMIT 1',
      [username, username]
    );
    return rows.length > 0;
  }

  async findLoginUser(username: string): Promise<LoginUser | null> {
    // Same query as ew-portal-api login (auroraClient.lookupByUsername)
    const rows = await this.rows(
      'SELECT ai.id AS accountId, ai.username AS username, ui.user_id AS userId, ' +
        'ui.institute_id AS instituteId, ai.organization AS organization ' +
        'FROM user_index ui JOIN account_index ai ON ai.id = ui.account_id ' +
        'WHERE ai.username = ? LIMIT 1',
      [username]
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      accountId: String(r.accountId),
      username: String(r.username),
      userId: String(r.userId),
      instituteId: String(r.instituteId),
      organization: String(r.organization),
    };
  }

  async findSessionUser(bmsUserId: string): Promise<LoginUser | null> {
    // Same query as ew-portal-api /auth/refresh (auroraClient.lookupByUserId)
    const rows = await this.rows(
      'SELECT ai.id AS accountId, ai.username AS username, ui.user_id AS userId, ' +
        'ui.institute_id AS instituteId, ai.organization AS organization ' +
        'FROM user_index ui JOIN account_index ai ON ai.id = ui.account_id ' +
        'WHERE ui.user_id = ? LIMIT 1',
      [bmsUserId]
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      accountId: String(r.accountId),
      username: String(r.username),
      userId: String(r.userId),
      instituteId: String(r.instituteId),
      organization: String(r.organization),
    };
  }

  async findUser(bmsUserId: string): Promise<IndexedUser | null> {
    const rows = await this.rows(
      'SELECT ui.user_id, ui.username, ui.account_id, ui.institute_id, ui.open_sim_user_id, ii.organization ' +
        'FROM user_index ui JOIN institute_index ii ON ii.institute_id = ui.institute_id ' +
        'WHERE ui.user_id = ? LIMIT 1',
      [bmsUserId]
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      userId: String(r.user_id),
      username: String(r.username),
      accountId: String(r.account_id),
      instituteId: String(r.institute_id),
      organization: String(r.organization) as Organization,
      openSimUserId: r.open_sim_user_id ? String(r.open_sim_user_id) : null,
    };
  }


  async avatarCodeExists(avatarCode: string): Promise<boolean> {
    const rows = await this.rows('SELECT 1 FROM avatar_index WHERE avatar_code = ? AND is_active = TRUE LIMIT 1', [
      avatarCode,
    ]);
    return rows.length > 0;
  }
}

export class MysqlGridRepository implements GridRepository {
  constructor(
    private readonly pool: Pool,
    private readonly timeoutMs: number
  ) {}

  private async rows(sql: string, values: unknown[]): Promise<RowDataPacket[]> {
    try {
      const [rows] = await this.pool.query<RowDataPacket[]>({ sql, values, timeout: this.timeoutMs });
      return rows;
    } catch (err) {
      throw dbFailure('GRID_DB_UNAVAILABLE', err);
    }
  }

  async nameExists(names: GridName[]): Promise<boolean> {
    if (names.length === 0) return false;
    const where = names.map(() => '(FirstName = ? AND LastName = ?)').join(' OR ');
    const rows = await this.rows(
      `SELECT 1 FROM useraccounts WHERE ${where} LIMIT 1`,
      names.flatMap(n => [n.firstName, n.lastName])
    );
    return rows.length > 0;
  }

  async principalExists(principalId: string): Promise<boolean> {
    const rows = await this.rows('SELECT 1 FROM useraccounts WHERE PrincipalID = ? LIMIT 1', [principalId]);
    return rows.length > 0;
  }

  async findPrincipalId(name: GridName): Promise<string | null> {
    // Robust refuses duplicate names, so at most one row matches
    const rows = await this.rows('SELECT PrincipalID FROM useraccounts WHERE FirstName = ? AND LastName = ? LIMIT 1', [
      name.firstName,
      name.lastName,
    ]);
    return rows.length > 0 ? String(rows[0].PrincipalID) : null;
  }
}

export class MysqlSystemRepository implements SystemRepository {
  constructor(
    private readonly pool: Pool,
    private readonly timeoutMs: number
  ) {}

  /** CALL a routine; returns its first result set ([] for routines that select nothing). */
  private async call(sql: string, values: unknown[]): Promise<RowDataPacket[]> {
    try {
      // CALL returns [resultSet, okPacket], or just the okPacket when the routine selects nothing
      const [sets] = await this.pool.query<RowDataPacket[][]>({ sql, values, timeout: this.timeoutMs });
      return Array.isArray(sets) && Array.isArray(sets[0]) ? sets[0] : [];
    } catch (err) {
      throw dbFailure('SYSTEM_DB_UNAVAILABLE', err);
    }
  }

  async createSession(s: NewSession): Promise<void> {
    await this.call('CALL sp_create_auth_session(?, ?, ?, ?, ?)', [
      s.sessionId,
      s.userId,
      s.refreshJti,
      s.ttlSeconds,
      s.clientIp,
    ]);
  }

  async rotateSession(
    sessionId: string,
    presentedJti: string,
    newJti: string,
    ttlSeconds: number,
    graceSeconds: number
  ): Promise<SessionRotation> {
    const [r] = await this.call('CALL sp_rotate_auth_session(?, ?, ?, ?, ?)', [
      sessionId,
      presentedJti,
      newJti,
      ttlSeconds,
      graceSeconds,
    ]);
    return {
      result: (r ? String(r.result) : 'NOT_FOUND') as SessionRotationResult,
      userId: r?.user_id ? String(r.user_id) : null,
      refreshJti: r?.refresh_jti ? String(r.refresh_jti) : null,
    };
  }

  async isSessionActive(sessionId: string): Promise<boolean> {
    const [r] = await this.call('CALL sp_check_auth_session(?)', [sessionId]);
    return !!r && Number(r.active) === 1;
  }

  async revokeSession(sessionId: string, reason: string): Promise<boolean> {
    const [r] = await this.call('CALL sp_revoke_auth_session(?, ?)', [sessionId, reason]);
    return !!r && Number(r.revoked) > 0;
  }

  async revokeUserSessions(userId: string, reason: string): Promise<number> {
    const [r] = await this.call('CALL sp_revoke_user_auth_sessions(?, ?)', [userId, reason]);
    return r ? Number(r.revoked) : 0;
  }

  async consumeServiceToken(tokenId: string): Promise<ServiceToken | null> {
    // The routine selects exactly one row
    const rows = await this.call('CALL sp_consume_service_action_token(?)', [tokenId]);
    const r = rows[0];
    if (!r || Number(r.found) !== 1) return null;
    return { action: String(r.action), subjectUserId: String(r.subject_user_id), actingUserId: String(r.acting_user_id) };
  }
}

export interface Databases {
  index: MysqlIndexRepository;
  grid: MysqlGridRepository;
  system: MysqlSystemRepository;
  close(): Promise<void>;
}

export function createDatabases(cfg: DbConfig): Databases {
  const indexPool = createPool(cfg, cfg.indexDbName);
  const gridPool = createPool(cfg, cfg.gridDbName);
  const systemPool = createPool(cfg, cfg.systemDbName);
  return {
    index: new MysqlIndexRepository(indexPool, cfg.timeoutMs),
    grid: new MysqlGridRepository(gridPool, cfg.timeoutMs),
    system: new MysqlSystemRepository(systemPool, cfg.timeoutMs),
    close: async () => {
      await Promise.allSettled([indexPool.end(), gridPool.end(), systemPool.end()]);
    },
  };
}
