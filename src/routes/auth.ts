import { isIP } from 'node:net';
import { Request, Router } from 'express';
import { logger } from '../utils/logger';
import { requireApiKey } from '../middleware/apiKey';
import { login, LoginDeps, LoginInput, LoginReply, mfaQr } from '../services/login';
import { REFRESH_TOKEN_COOKIE } from '../services/tokens';

// /auth/* — called by ew-portal-api, which proxies the Portal frontend's requests unchanged and
// sends the end user's IP in X-Client-IP: the address its public ALB saw (Express req.ip with
// trust proxy = 1). The rate limit and captcha are keyed on it. X-Forwarded-For is NOT used: its
// first entry is whatever the client sent, so it can be faked to get fresh counters. X-Client-IP
// is trusted only because the request carries the caller's X-Api-Key.
export function createAuthRouter(apiKey: string, deps: LoginDeps): Router {
  const router = Router();
  router.use('/auth', requireApiKey(apiKey));

  const clientIp = (req: Request): string => {
    const ip = (req.get('X-Client-IP') ?? '').trim();
    if (isIP(ip)) return ip;
    // No usable client IP: every request from this caller shares one counter per username
    logger.warn('Login: X-Client-IP missing or invalid; rate limit falls back to per-username', {
      path: req.originalUrl,
      given: ip ? 'invalid' : 'missing',
    });
    return 'unknown';
  };

  const input = (req: Request): LoginInput => {
    const b = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    return { username: b.username, password: b.password, captchaToken: b.captchaToken, mfaToken: b.mfaToken, ip: clientIp(req) };
  };

  const send = (res: import('express').Response, r: LoginReply) => {
    for (const [k, v] of Object.entries(r.headers ?? {})) res.setHeader(k, v);
    if (r.refreshToken) res.cookie(REFRESH_TOKEN_COOKIE, r.refreshToken, deps.tokens.refreshCookieOptions());
    res.setHeader('Cache-Control', 'no-store');
    res.status(r.status).json(r.body);
  };

  // { username, password, captchaToken?, mfaToken? }
  router.post('/auth/login', async (req, res) => {
    send(res, await login(deps, input(req)));
  });

  // { username, password, captchaToken? } → image/png (QR of the never-verified MFA secret)
  router.post('/auth/mfa/qr', async (req, res) => {
    const r = await mfaQr(deps, input(req));
    if ('png' in r) {
      res.setHeader('Cache-Control', 'no-store'); // carries the TOTP secret
      res.type('png').send(r.png);
      return;
    }
    send(res, r);
  });

  return router;
}
