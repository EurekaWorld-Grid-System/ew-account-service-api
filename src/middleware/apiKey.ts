import { NextFunction, Request, RequestHandler, Response } from 'express';
import { secureEquals } from '../utils/secureCompare';
import { logger } from '../utils/logger';

// Callers (v1.0: ew-portal-api) authenticate with X-Api-Key. The network already limits
// who can reach the service (internal ALB security group); the key is the second layer.
export function requireApiKey(expected: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const given = req.get('X-Api-Key');
    if (!given || !secureEquals(given, expected)) {
      logger.warn('Rejected request: missing or invalid X-Api-Key', { path: req.baseUrl + req.path, ip: req.ip });
      res.status(401).json({ code: 'INVALID_API_KEY', message: 'Missing or invalid X-Api-Key header' });
      return;
    }
    next();
  };
}
