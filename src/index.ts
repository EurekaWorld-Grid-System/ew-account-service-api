import { createApp } from './app';
import { config, loadRegistrationConfig, API_VERSION, SERVICE_NAME } from './config';
import { createDatabases } from './services/db';
import { HttpRobustClient } from './services/robust';
import { HttpBmsAdapterClient } from './services/bmsAdapter';
import { logger } from './utils/logger';

const reg = loadRegistrationConfig();
const dbs = createDatabases(reg.db);

const app = createApp({
  apiKey: reg.apiKey,
  registration: {
    index: dbs.index,
    grid: dbs.grid,
    robust: new HttpRobustClient(reg.robustBaseUrl, reg.robustTimeoutMs),
    bms: new HttpBmsAdapterClient(reg.bmsAdapterBaseUrl, reg.bmsAdapterApiKey, reg.bmsAdapterTimeoutMs),
    robustSkip: reg.robustSkip,
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
