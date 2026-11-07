import { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';

// Every error response is { code, message } (Developers Guide: Error responses).

export function notFound(req: Request, res: Response): void {
  res.status(404).json({ code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) return;
  if (err instanceof AppError) {
    res.status(err.status).json({ code: err.code, message: err.message });
    return;
  }

  const e = err as { type?: string; status?: number; message?: string; stack?: string };

  if (e?.type === 'entity.parse.failed') {
    res.status(400).json({ code: 'INVALID_JSON', message: 'Request body is not valid JSON' });
    return;
  }
  if (e?.type === 'entity.too.large') {
    res.status(413).json({ code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' });
    return;
  }

  logger.error('Unhandled error', { method: req.method, path: req.path, message: e?.message, stack: e?.stack });
  res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
}
