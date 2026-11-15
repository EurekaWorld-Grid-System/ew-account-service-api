import { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Organization } from '../services/types';
import { logger } from '../utils/logger';

// User authentication for /account/* routes: the caller (ew-portal-api) forwards the user's
// Authorization: Bearer <access token>. During the migration the tokens are issued by
// ew-portal-api with the shared RS256 key pair (Pre-Launch Security Design §4.4); this service
// only verifies them with the public key.
//
// 401 responses follow the system-wide rule: TOKEN_EXPIRED for an expired token (the frontend
// refreshes and retries), TOKEN_INVALID for anything else (redirect to login).

export interface AccessTokenUser {
  /** BMS Users.UserId */
  userId: string;
  accountId: string;
  username: string;
  globalRole: string;
  organization: Organization;
  instituteId: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AccessTokenUser;
  }
}

function invalid(res: Response, message = 'Invalid token'): void {
  res.status(401).json({ code: 'TOKEN_INVALID', message });
}

export function requireAccessToken(publicKey: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.get('Authorization');
    if (!header?.startsWith('Bearer ')) {
      invalid(res, 'Missing or invalid Authorization header');
      return;
    }

    let payload: jwt.JwtPayload;
    try {
      const decoded = jwt.verify(header.slice(7), publicKey, { algorithms: ['RS256'] });
      if (typeof decoded === 'string') throw new Error('string payload');
      payload = decoded;
    } catch (err) {
      if ((err as Error).name === 'TokenExpiredError') {
        res.status(401).json({ code: 'TOKEN_EXPIRED', message: 'Access token expired' });
        return;
      }
      logger.warn('Rejected access token', { path: req.originalUrl, reason: (err as Error).message });
      invalid(res);
      return;
    }

    // Refresh tokens and challenge tokens are signed with the same key but carry a `type`
    // claim; access tokens don't. Never accept them as access tokens.
    const p = payload as Record<string, unknown>;
    if (
      p.type !== undefined ||
      typeof p.sub !== 'string' ||
      typeof p.accountId !== 'string' ||
      typeof p.instituteId !== 'string' ||
      (p.organization !== 'edu' && p.organization !== 'general')
    ) {
      logger.warn('Rejected token: not an access token', { path: req.originalUrl, type: p.type ?? null });
      invalid(res);
      return;
    }

    req.user = {
      userId: p.sub,
      accountId: p.accountId,
      username: typeof p.username === 'string' ? p.username : '',
      globalRole: typeof p.globalRole === 'string' ? p.globalRole : '',
      organization: p.organization,
      instituteId: p.instituteId,
    };
    next();
  };
}
