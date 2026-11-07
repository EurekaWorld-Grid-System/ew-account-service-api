import { Router } from 'express';
import { requireApiKey } from '../middleware/apiKey';
import {
  checkCoupon,
  checkEmailAvailable,
  checkUsernameAvailable,
  parseCouponCode,
  parseEmail,
  parseUsername,
  register,
} from '../services/registration';
import { RegistrationDeps } from '../services/types';

// Registration endpoints (design §6.3). Every route needs the caller's X-Api-Key.
export function createRegistrationRouter(apiKey: string, deps: RegistrationDeps): Router {
  const router = Router();
  router.use('/registration', requireApiKey(apiKey));

  const body = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {});

  router.post('/registration/validate-coupon', async (req, res) => {
    const coupon = await checkCoupon(deps, parseCouponCode(body(req.body).couponCode));
    res.json({ valid: true, licenseId: coupon.licenseId, instituteId: coupon.instituteId });
  });

  router.post('/registration/validate-email', async (req, res) => {
    await checkEmailAvailable(deps, parseEmail(body(req.body).email));
    res.json({ available: true });
  });

  router.post('/registration/validate-username', async (req, res) => {
    await checkUsernameAvailable(deps, parseUsername(body(req.body).username));
    res.json({ available: true });
  });

  router.post('/registration', async (req, res) => {
    const result = await register(deps, body(req.body));
    res.status(201).json(result);
  });

  return router;
}
