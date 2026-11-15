import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

// Development reads .env; in ECS every value comes from the task definition
// (config) or Secrets Manager (secrets), and there is no .env file.
dotenv.config({ quiet: true });

// package.json sits one level above both src/ (tsx in dev) and dist/ (prod image)
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function boolEnv(name: string): boolean {
  return (process.env[name] ?? '').trim().toLowerCase() === 'true';
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return n;
}

const nodeEnv = process.env.NODE_ENV ?? 'development';
const gitCommit = (process.env.GIT_COMMIT ?? 'unknown').slice(0, 7);

export const SERVICE_NAME = pkg.name;
/** `<package version>+<short commit>` in images built by deploy.sh, else just the package version. */
export const API_VERSION = gitCommit === 'unknown' ? pkg.version : `${pkg.version}+${gitCommit}`;

export const config = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  // Internal-only component: container port 8080 (Developers Guide: Ports and exposure)
  port: intEnv('PORT', 8080),
  logLevel: process.env.LOG_LEVEL ?? (nodeEnv === 'production' ? 'info' : 'debug'),
  // json = structured (ECS/CloudWatch), pretty = human-readable (dev)
  logFormat: process.env.LOG_FORMAT ?? (nodeEnv === 'production' ? 'json' : 'pretty'),
  shutdownTimeoutMs: intEnv('SHUTDOWN_TIMEOUT_MS', 15_000),
};

// ── Registration (read once at startup by index.ts, so a missing variable stops the
//    service immediately instead of failing the first request) ─────────────────────
export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  indexDbName: string;
  gridDbName: string;
  timeoutMs: number;
}

export interface RegistrationConfig {
  // Key callers (ew-portal-api) present in X-Api-Key (secret)
  apiKey: string;
  db: DbConfig;
  robustBaseUrl: string;
  robustTimeoutMs: number;
  robustSkip: boolean;
  bmsAdapterBaseUrl: string;
  bmsAdapterApiKey: string;
  bmsAdapterTimeoutMs: number;
}

export function loadRegistrationConfig(): RegistrationConfig {
  const robustSkip = boolEnv('ROBUST_SKIP');
  if (robustSkip && nodeEnv === 'production') {
    throw new Error('ROBUST_SKIP=true is not allowed in production');
  }
  const withScheme = (url: string) => (/^https?:\/\//i.test(url) ? url : `http://${url}`).replace(/\/+$/, '');
  return {
    apiKey: requireEnv('ACCOUNT_SERVICE_API_KEY'),
    db: {
      host: requireEnv('AURORA_HOST'),
      port: intEnv('AURORA_PORT', 3306),
      user: requireEnv('AURORA_USER'),
      password: requireEnv('AURORA_PASSWORD'),
      indexDbName: requireEnv('INDEX_DB_NAME'),
      gridDbName: requireEnv('GRID_DB_NAME'),
      timeoutMs: intEnv('DB_TIMEOUT_MS', 3000),
    },
    // Not needed in ROBUST_SKIP mode
    robustBaseUrl: robustSkip ? (process.env.ROBUST_BASE_URL ?? '') : withScheme(requireEnv('ROBUST_BASE_URL')),
    robustTimeoutMs: intEnv('ROBUST_TIMEOUT_MS', 20_000),
    robustSkip,
    bmsAdapterBaseUrl: withScheme(requireEnv('BMS_ADAPTER_BASE_URL')),
    bmsAdapterApiKey: requireEnv('BMS_ADAPTER_API_KEY'),
    bmsAdapterTimeoutMs: intEnv('BMS_ADAPTER_TIMEOUT_MS', 10_000),
  };
}
