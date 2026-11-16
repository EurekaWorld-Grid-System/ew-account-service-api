import { Request, Router } from 'express';
import { requireApiKey } from '../middleware/apiKey';
import { login, LoginDeps, LoginInput, LoginReply, mfaQr } from '../services/login';
import { REFRESH_TOKEN_COOKIE } from '../services/tokens';

// /auth/* — called by ew-portal-api, which proxies the Portal frontend's requests unchanged and
// passes the end user's IP in X-Forwarded-For (first entry), as its own ALB gave it.
export function createAuthRouter(apiKey: string, deps: LoginDeps): Router {
  const router = Router();
  router.use('/auth', requireApiKey(apiKey));

  // Same IP rule as ew-portal-api: first X-Forwarded-For entry, else the socket address
  const clientIp = (req: Request): string =>
    (req.get('X-Forwarded-For') ?? '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

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
