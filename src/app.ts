import express, { Express } from 'express';
import helmet from 'helmet';

import { API_VERSION, SERVICE_NAME } from './config';
import { logger } from './utils/logger';
import { errorHandler, notFound } from './middleware/errorHandler';
import { createRegistrationRouter } from './routes/registration';
import { RegistrationDeps } from './services/types';

export interface AppOptions {
  apiKey: string;
  registration: RegistrationDeps;
}

// Internal-only API: called by backends (v1.0: ew-portal-api) inside the VPC through
// the internal ALB. No browser callers, so no CORS.
export function createApp(opts: AppOptions): Express {
  const app = express();

  // Reached only through the internal ALB (one proxy hop)
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());

  // ── Request logging (never bodies: they carry passwords; health checks excluded) ──
  app.use((req, _res, next) => {
    if (req.path !== '/health') logger.info('Incoming request', { method: req.method, path: req.path, ip: req.ip });
    next();
  });

  app.use(express.json({ limit: '16kb' }));

  // ── Health check (container health check + internal ALB target group) ────────
  // Liveness only: it must not depend on Aurora, Robust or bms-adapter, or an outage
  // there would make ECS replace healthy tasks.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: SERVICE_NAME, version: API_VERSION });
  });

  // ── Routes ───────────────────────────────────────────────────────────────────
  app.use(createRegistrationRouter(opts.apiKey, opts.registration));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
