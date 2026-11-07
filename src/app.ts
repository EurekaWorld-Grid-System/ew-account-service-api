import express from 'express';
import helmet from 'helmet';

import { API_VERSION, SERVICE_NAME } from './config';
import { logger } from './utils/logger';
import { errorHandler, notFound } from './middleware/errorHandler';

export const app = express();

// Reached only through the internal ALB (one proxy hop)
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet());

// ── Request logging (health checks excluded: ALB + container check every 30 s) ──
app.use((req, _res, next) => {
  if (req.path !== '/health') logger.info('Incoming request', { method: req.method, path: req.path, ip: req.ip });
  next();
});

app.use(express.json({ limit: '100kb' }));

// ── Health check (container health check + internal ALB target group) ────────
// Liveness only: it must not depend on Aurora, Robust or the mail gateway, or an outage there
// would make ECS replace healthy tasks. Dependency checks will go on /ready.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: SERVICE_NAME, version: API_VERSION });
});

// ── Routes ───────────────────────────────────────────────────────────────────
// Registration endpoints (/registration/*) are added here next
// (EurekaWorld_Account_Service_Design_v1.0 §6).

app.use(notFound);
app.use(errorHandler);
