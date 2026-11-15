import { Router } from 'express';
import { requireApiKey } from '../middleware/apiKey';
import { requireAccessToken } from '../middleware/accessToken';
import { changePassword } from '../services/passwordChange';
import { PasswordChangeDeps } from '../services/types';

// /account/* routes act for a logged-in user: the caller's X-Api-Key AND the user's Bearer
// access token are both required.
export function createAccountRouter(apiKey: string, jwtPublicKey: string, deps: PasswordChangeDeps): Router {
  const router = Router();
  router.use('/account', requireApiKey(apiKey), requireAccessToken(jwtPublicKey));

  router.post('/account/change-password', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    const u = req.user!;
    const result = await changePassword(
      deps,
      { userId: u.userId, organization: u.organization, instituteId: u.instituteId, accountId: u.accountId, username: u.username },
      body
    );
    res.json(result);
  });

  return router;
}
