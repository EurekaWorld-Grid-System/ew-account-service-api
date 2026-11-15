import { Router } from 'express';
import { requireApiKey } from '../middleware/apiKey';
import { changePassword, resetPasswordBySystem } from '../services/passwordChange';
import { PasswordChangeDeps } from '../services/types';

// /users/:userId/password* — userId is the BMS Users.UserId (user_index.user_id).
// Every route needs the caller's X-Api-Key.
export function createUsersRouter(apiKey: string, deps: PasswordChangeDeps): Router {
  const router = Router();
  router.use('/users', requireApiKey(apiKey));

  const body = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {});

  // Every password change except forgot-password: the acting user proves their current password
  router.put('/users/:userId/password', async (req, res) => {
    res.json(await changePassword(deps, req.params.userId, body(req.body)));
  });

  // Forgot-password: one-time `system:set-password` service token (X-Service-Token)
  router.post('/users/:userId/password/reset', async (req, res) => {
    res.json(await resetPasswordBySystem(deps, req.params.userId, req.get('X-Service-Token'), body(req.body)));
  });

  return router;
}
