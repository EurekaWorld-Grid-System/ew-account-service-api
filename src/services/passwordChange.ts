import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { parsePassword } from '../utils/password';
import { BmsUserRef, PasswordChangeDeps } from './types';

// POST /account/change-password (Pre-Launch Security Design §1). Same BMS steps ew-portal-api
// performed, plus the grid password sync through the registration Robust.

export interface PasswordChangeResult {
  status: 'password_changed';
  /** ok: grid password updated · failed: BMS changed, grid not (GRID_PASSWORD_SYNC_FAILED) · skipped: ROBUST_SKIP */
  gridSync: 'ok' | 'failed' | 'skipped';
  code?: 'GRID_PASSWORD_SYNC_FAILED';
}

export async function changePassword(
  deps: PasswordChangeDeps,
  user: BmsUserRef & { accountId: string; username: string },
  body: Record<string, unknown>
): Promise<PasswordChangeResult> {
  // 1. Shapes
  if (typeof body.oldPassword !== 'string' || body.oldPassword === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'oldPassword is required');
  }
  const oldPassword = body.oldPassword;
  const newPassword = parsePassword(body.newPassword, 'newPassword');
  if (newPassword === oldPassword) {
    throw new AppError(400, 'VALIDATION_ERROR', 'newPassword must differ from the current password');
  }

  // 2. Current password (BMS hash)
  const credentials = await deps.bms.getCredentials(user);
  if (!credentials) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  const hash = await deps.bms.computeHash(oldPassword, credentials.salt);
  if (hash !== credentials.hashCode) {
    throw new AppError(401, 'WRONG_CURRENT_PASSWORD', 'Current password is incorrect');
  }

  // 3. Password history, then 4. the new BMS password (bms-adapter keeps the history)
  if (!(await deps.bms.isPasswordAllowed(user, newPassword))) {
    throw new AppError(400, 'PASSWORD_RECENTLY_USED', 'This password was used recently');
  }
  await deps.bms.setPassword(user, newPassword);
  logger.info('Password changed in BMS', { accountId: user.accountId, username: user.username });

  // 5. Grid password (registration Robust). BMS has already changed: a failure here is a
  //    partial success, logged for manual repair, never rolled back.
  if (deps.robustSkip) {
    logger.warn('ROBUST_SKIP: grid password not synced', { accountId: user.accountId });
    return { status: 'password_changed', gridSync: 'skipped' };
  }
  try {
    const principalId = await deps.index.findOpenSimUserId(user.userId);
    // Robust's endpoint writes an auth row for any UUID, so only call it for an existing grid user
    if (!principalId || !(await deps.grid.principalExists(principalId))) {
      logger.error('Grid password sync: no grid account for this user', {
        accountId: user.accountId,
        bmsUserId: user.userId,
        openSimUserId: principalId,
      });
      throw new AppError(502, 'GRID_PASSWORD_SYNC_FAILED', 'No grid account');
    }
    await deps.robust.setPassword(principalId, newPassword);
    logger.info('Grid password synced', { accountId: user.accountId, openSimUserId: principalId });
    return { status: 'password_changed', gridSync: 'ok' };
  } catch (err) {
    logger.error('Password changed in BMS but not in the grid: manual repair needed', {
      accountId: user.accountId,
      username: user.username,
      bmsUserId: user.userId,
      error: err instanceof AppError ? err.code : (err as Error).message,
    });
    return { status: 'password_changed', gridSync: 'failed', code: 'GRID_PASSWORD_SYNC_FAILED' };
  }
}
