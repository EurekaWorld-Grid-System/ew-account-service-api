import { AppError } from '../utils/errors';
import { secureEquals } from '../utils/secureCompare';
import { logger } from '../utils/logger';
import { parsePassword } from '../utils/password';
import { BmsUserRef, IndexedUser, PasswordChangeDeps } from './types';

// Password changes (Pre-Launch Security Design §1). Two entry points, one write path:
// - resetPasswordBySystem: the forgot-password flow. ew-portal-api authenticates the user with the
//   emailed code, then mints a one-time `system:set-password` service token for this call.
// - changePassword: every other change (own, admin, teacher). The acting user (who may be the
//   user themself) proves their CURRENT password; isInitial/expiry don't matter here.
// Both then: password standard → history → BMS password → grid password (registration Robust).
//
// Later: rules on who may change whose password (e.g. a regular user can't change an admin's).

export const SYSTEM_SET_PASSWORD_ACTION = 'system:set-password';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PasswordChangeResult {
  status: 'password_changed';
  /** ok: grid password updated · failed: BMS changed, grid not (GRID_PASSWORD_SYNC_FAILED) · skipped: ROBUST_SKIP */
  gridSync: 'ok' | 'failed' | 'skipped';
  code?: 'GRID_PASSWORD_SYNC_FAILED';
}

export function parseUserId(v: unknown, field = 'userId'): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new AppError(400, 'VALIDATION_ERROR', `${field} must be a UUID`);
  return v.toLowerCase();
}

async function findUserOr404(deps: PasswordChangeDeps, userId: string): Promise<IndexedUser> {
  const user = await deps.index.findUser(userId);
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  return user;
}

/**
 * Password authentication: the user's current BMS password, whatever its state (initial or
 * expired). Copied from ew-portal-api (GET /users/{id}/credentials + POST /users/compute-hash).
 */
export async function verifyPassword(deps: PasswordChangeDeps, user: BmsUserRef, password: string): Promise<boolean> {
  const credentials = await deps.bms.getCredentials(user);
  if (!credentials) return false;
  const hash = await deps.bms.computeHash(password, credentials.salt);
  return secureEquals(hash.toLowerCase(), credentials.hashCode.toLowerCase());
}

/** History → BMS → grid. The new password has already passed the standard. */
async function writePassword(
  deps: PasswordChangeDeps,
  user: IndexedUser,
  newPassword: string,
  isInitial: boolean,
  ctx: Record<string, unknown>
): Promise<PasswordChangeResult> {
  if (!(await deps.bms.isPasswordAllowed(user, newPassword))) {
    throw new AppError(400, 'PASSWORD_RECENTLY_USED', 'This password was used recently');
  }
  await deps.bms.setPassword(user, newPassword, isInitial);
  logger.info('Password changed in BMS', { ...ctx, userId: user.userId, accountId: user.accountId, isInitial });

  // Grid password (registration Robust). BMS has already changed: a failure here is a partial
  // success, logged for manual repair, never rolled back.
  if (deps.robustSkip) {
    logger.warn('ROBUST_SKIP: grid password not synced', { userId: user.userId });
    return { status: 'password_changed', gridSync: 'skipped' };
  }
  try {
    const principalId = user.openSimUserId;
    // Robust's endpoint writes an auth row for any UUID, so only call it for an existing grid user
    if (!principalId || !(await deps.grid.principalExists(principalId))) {
      throw new AppError(502, 'GRID_PASSWORD_SYNC_FAILED', `No grid account (openSimUserId ${principalId ?? 'null'})`);
    }
    await deps.robust.setPassword(principalId, newPassword);
    logger.info('Grid password synced', { userId: user.userId, openSimUserId: principalId });
    return { status: 'password_changed', gridSync: 'ok' };
  } catch (err) {
    logger.error('Password changed in BMS but not in the grid: manual repair needed', {
      ...ctx,
      userId: user.userId,
      accountId: user.accountId,
      username: user.username,
      openSimUserId: user.openSimUserId,
      error: err instanceof AppError ? `${err.code}: ${err.message}` : (err as Error).message,
    });
    return { status: 'password_changed', gridSync: 'failed', code: 'GRID_PASSWORD_SYNC_FAILED' };
  }
}

/** PUT /users/:userId/password — any change where the acting user proves their current password. */
export async function changePassword(
  deps: PasswordChangeDeps,
  userIdParam: unknown,
  body: Record<string, unknown>
): Promise<PasswordChangeResult> {
  const userId = parseUserId(userIdParam);
  const actingUserId = parseUserId(body.actingUserId, 'actingUserId');
  if (typeof body.actingUserPassword !== 'string' || body.actingUserPassword === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'actingUserPassword is required');
  }
  const actingUserPassword = body.actingUserPassword;
  const newPassword = parsePassword(body.newPassword, 'newPassword');
  if (body.isInitial !== undefined && typeof body.isInitial !== 'boolean') {
    throw new AppError(400, 'VALIDATION_ERROR', 'isInitial must be a boolean');
  }
  const isInitial = body.isInitial === true;
  const self = actingUserId === userId;
  if (self && newPassword === actingUserPassword) {
    throw new AppError(400, 'VALIDATION_ERROR', 'newPassword must differ from the current password');
  }

  // Acting user's own password (their own org/institute), whatever its state
  const actingUser = await deps.index.findUser(actingUserId);
  if (!actingUser || !(await verifyPassword(deps, actingUser, actingUserPassword))) {
    logger.warn('Password change refused: acting user password mismatch', { userId, actingUserId });
    throw new AppError(401, 'INVALID_ACTING_USER_PASSWORD', 'Invalid credentials');
  }

  const user = self ? actingUser : await findUserOr404(deps, userId);
  return writePassword(deps, user, newPassword, isInitial, { actingUserId, self });
}

/** POST /users/:userId/password/reset — forgot-password; needs a `system:set-password` service token. */
export async function resetPasswordBySystem(
  deps: PasswordChangeDeps,
  userIdParam: unknown,
  serviceToken: string | undefined,
  body: Record<string, unknown>
): Promise<PasswordChangeResult> {
  const userId = parseUserId(userIdParam);
  if (!serviceToken || !UUID_RE.test(serviceToken)) {
    throw new AppError(403, 'INVALID_SERVICE_TOKEN', 'Invalid or expired service token');
  }
  const newPassword = parsePassword(body.newPassword, 'newPassword');

  // One-time: consumed before any other check, so a token can never be replayed
  if (!(await deps.index.consumeServiceToken(serviceToken, SYSTEM_SET_PASSWORD_ACTION, userId))) {
    logger.warn('Password reset refused: invalid or expired service token', { userId });
    throw new AppError(403, 'INVALID_SERVICE_TOKEN', 'Invalid or expired service token');
  }

  const user = await findUserOr404(deps, userId);
  return writePassword(deps, user, newPassword, false, { by: 'system' });
}
