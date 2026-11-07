import mysql, { Pool, RowDataPacket } from 'mysql2/promise';
import { DbConfig } from '../config';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { CouponInfo, GridName, GridRepository, IndexRepository, Organization } from './types';

// Two pools on the same Aurora cluster and database user (SELECT only), different
// databases: ew_index and the OpenSim grid DB (design §4).
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

function dbFailure(code: 'GRID_DB_UNAVAILABLE' | 'INDEX_DB_UNAVAILABLE', err: unknown): AppError {
  // Log the driver's error code/message only: never SQL parameters
  const e = err as { code?: string; message?: string };
  logger.error('Database query failed', { code, dbErrorCode: e.code, dbMessage: e.message });
  return new AppError(503, code, code === 'GRID_DB_UNAVAILABLE' ? 'Grid database unavailable' : 'Index database unavailable');
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
      'SELECT li.license_id, li.institute_id, ii.organization ' +
        'FROM license_index li JOIN institute_index ii ON ii.institute_id = li.institute_id ' +
        'WHERE li.coupon_code = ? LIMIT 1',
      [couponCode]
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      licenseId: String(r.license_id),
      instituteId: String(r.institute_id),
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

  async findPrincipalId(name: GridName): Promise<string | null> {
    // Robust refuses duplicate names, so at most one row matches
    const rows = await this.rows('SELECT PrincipalID FROM useraccounts WHERE FirstName = ? AND LastName = ? LIMIT 1', [
      name.firstName,
      name.lastName,
    ]);
    return rows.length > 0 ? String(rows[0].PrincipalID) : null;
  }
}

export interface Databases {
  index: MysqlIndexRepository;
  grid: MysqlGridRepository;
  close(): Promise<void>;
}

export function createDatabases(cfg: DbConfig): Databases {
  const indexPool = createPool(cfg, cfg.indexDbName);
  const gridPool = createPool(cfg, cfg.gridDbName);
  return {
    index: new MysqlIndexRepository(indexPool, cfg.timeoutMs),
    grid: new MysqlGridRepository(gridPool, cfg.timeoutMs),
    close: async () => {
      await Promise.allSettled([indexPool.end(), gridPool.end()]);
    },
  };
}
