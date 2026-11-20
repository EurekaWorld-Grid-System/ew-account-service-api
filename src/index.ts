import { createApp } from './app';
import { config, loadLoginConfig, loadRegistrationConfig, API_VERSION, SERVICE_NAME } from './config';
import { MemoryLoginGuard, MemoryMfaGuard, recaptchaVerifier } from './services/loginGuard';
import { TokenIssuer } from './services/tokens';
import { createDatabases } from './services/db';
import { HttpRobustClient } from './services/robust';
import { HttpBmsAdapterClient } from './services/bmsAdapter';
import { logger } from './utils/logger';

const reg = loadRegistrationConfig();
const loginCfg = loadLoginConfig();
const dbs = createDatabases(reg.db);
const bms = new HttpBmsAdapterClient(reg.bmsAdapterBaseUrl, reg.bmsAdapterApiKey, reg.bmsAdapterTimeoutMs);

const app = createApp({
  apiKey: reg.apiKey,
  registration: {
    index: dbs.index,
    grid: dbs.grid,
    system: dbs.system,
    robust: new HttpRobustClient(reg.robustBaseUrl, reg.robustTimeoutMs),
    bms,
    robustSkip: reg.robustSkip,
  },
  login: {
    index: dbs.index,
    bms,
    system: dbs.system,
    guard: new MemoryLoginGuard(),
    mfaGuard: new MemoryMfaGuard(),
    verifyCaptcha: recaptchaVerifier(loginCfg.recaptchaSecretKey),
    tokens: new TokenIssuer({
      privateKey: loginCfg.jwtPrivateKey,
      accessTokenExpiry: loginCfg.accessTokenExpiry,
      refreshTokenExpiry: loginCfg.refreshTokenExpiry,
      cookieDomain: loginCfg.cookieDomain,
      secureCookies: config.isProduction,
    }),
    bmsLoginFallback: loginCfg.bmsLoginFallback,
  },
});

const server = app.listen(config.port, () => {
  logger.info(`${SERVICE_NAME} started`, { port: config.port, env: config.nodeEnv, version: API_VERSION });
  if (reg.robustSkip) logger.warn('ROBUST_SKIP is enabled: registrations create no grid account');
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
// ECS sends SIGTERM before stopping a task: stop accepting connections, let
// in-flight requests finish while the ALB drains, force-exit after the timeout.
let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down gracefully`);

  server.close(async err => {
    await dbs.close();
    if (err) {
      logger.error('Error during shutdown', { message: err.message });
      process.exit(1);
    }
    logger.info('All connections closed, exiting');
    process.exit(0);
  });
  server.closeIdleConnections();

  setTimeout(() => {
    logger.warn('Shutdown timeout exceeded, forcing exit');
    process.exit(1);
  }, config.shutdownTimeoutMs).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
