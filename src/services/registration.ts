import crypto from 'node:crypto';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { conflictingGridNames, gridNameFor, isValidUsername } from './gridName';
import { CouponInfo, RegistrationDeps } from './types';

// Registration backend (EurekaWorld_Account_Service_Design §6). Email verification is
// the Portal's domain: this service only checks that the email is not registered.

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
// EurekaWorld password standard (Registration Wizard Architecture v1.0 §4, MoE-compliant):
// at least 10 characters, at least one English letter and one digit, and only
// English letters, digits and !@#$%^&*(). 128 = upper bound against abuse.
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;
const PASSWORD_ALLOWED_RE = /^[A-Za-z0-9!@#$%^&*()]+$/;

function validationError(message: string): AppError {
  return new AppError(400, 'VALIDATION_ERROR', message);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v.trim() : undefined;
}

// ── Field parsing (shape only; no DB) ─────────────────────────────────────────

export function parseCouponCode(v: unknown): string {
  const s = str(v);
  if (!s || s.length > 100) throw validationError('couponCode is required (max 100 characters)');
  return s;
}

/** Empty or missing → null (email is optional, account_index.email is nullable). */
export function parseOptionalEmail(v: unknown): string | null {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return null;
  return parseEmail(v);
}

export function parseEmail(v: unknown): string {
  const s = str(v)?.toLowerCase();
  if (!s || s.length > 100 || !EMAIL_RE.test(s)) throw validationError('email must be a valid email address (max 100 characters)');
  return s;
}

export function parseUsername(v: unknown): string {
  // Inner whitespace collapsed to one space ("First   Last" → "First Last")
  const s = str(v)?.replace(/\s+/g, ' ');
  if (!s || !isValidUsername(s)) {
    throw new AppError(
      400,
      'INVALID_USERNAME',
      'username must be one or two words of 1-64 letters (a-z, A-Z), digits or underscores; ' +
        'a second word may not be "EW" or "Resident"'
    );
  }
  return s;
}

function parseName(field: string, v: unknown): string {
  const s = str(v);
  if (!s || s.length > 100) throw validationError(`${field} is required (max 100 characters)`);
  return s;
}

function parsePassword(v: unknown): string {
  if (
    typeof v !== 'string' ||
    v.length < PASSWORD_MIN ||
    v.length > PASSWORD_MAX ||
    !PASSWORD_ALLOWED_RE.test(v) ||
    !/[A-Za-z]/.test(v) ||
    !/[0-9]/.test(v)
  ) {
    throw validationError(
      `password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters of English letters, digits and !@#$%^&*(), ` +
        'with at least one letter and one digit'
    );
  }
  return v;
}

function parseAvatarCode(v: unknown): string {
  const s = str(v);
  if (!s || s.length > 64) throw validationError('avatarCode is required (max 64 characters)');
  return s;
}

// ── Pre-flight checks (§6.1) ──────────────────────────────────────────────────

export async function checkCoupon(deps: RegistrationDeps, couponCode: string): Promise<CouponInfo> {
  const coupon = await deps.index.findCoupon(couponCode);
  if (!coupon) throw new AppError(404, 'COUPON_NOT_FOUND', 'Coupon code not found');
  return coupon;
}

export async function checkEmailAvailable(deps: RegistrationDeps, email: string): Promise<void> {
  if (await deps.index.emailExists(email)) {
    throw new AppError(409, 'EMAIL_ALREADY_IN_USE', 'This email address is already registered');
  }
}

export async function checkUsernameAvailable(deps: RegistrationDeps, username: string): Promise<void> {
  // ew_index first (cheap), then the grid for pre-BMS-era accounts
  if ((await deps.index.usernameExists(username)) || (await deps.grid.nameExists(conflictingGridNames(username)))) {
    throw new AppError(409, 'USERNAME_ALREADY_IN_USE', 'Username is not available');
  }
}

// ── POST /registration (§6.2) ─────────────────────────────────────────────────

export interface RegistrationResult {
  accountId: string | null;
  username: string;
}

export async function register(deps: RegistrationDeps, body: Record<string, unknown>): Promise<RegistrationResult> {
  // 0. Shape of every field before any lookup
  const couponCode = parseCouponCode(body.couponCode);
  const email = parseOptionalEmail(body.email);
  const username = parseUsername(body.username);
  const firstName = parseName('firstName', body.firstName);
  const lastName = parseName('lastName', body.lastName);
  const password = parsePassword(body.password);
  const avatarCode = parseAvatarCode(body.avatarCode);

  // 1-4. Coupon, email, username (live checks at submission time)
  const coupon = await checkCoupon(deps, couponCode);
  if (email) await checkEmailAvailable(deps, email);
  await checkUsernameAvailable(deps, username);

  // 5. Avatar alias must be in avatar_index (Robust maps it to a template avatar)
  if (!(await deps.index.avatarCodeExists(avatarCode))) {
    throw new AppError(400, 'INVALID_AVATAR_CODE', 'Unknown avatar code');
  }

  // 6-7. Grid account through Robust, then its PrincipalID from the grid DB
  const gridName = gridNameFor(username);
  let openSimUserId: string;
  if (deps.robustSkip) {
    openSimUserId = crypto.randomUUID();
    logger.warn('ROBUST_SKIP: no grid account created, random openSimUserId used', { username, openSimUserId });
  } else {
    await deps.robust.createAccount({ first: gridName.firstName, last: gridName.lastName, password, avatar: avatarCode });
    const principalId = await deps.grid.findPrincipalId(gridName);
    if (!principalId) {
      logger.error('Robust created the grid account but it is not in useraccounts: investigate', { username, gridName });
      throw new AppError(502, 'USER_LOOKUP_FAILED', 'Grid account created but not found');
    }
    openSimUserId = principalId;
  }

  // 8. BMS user + ew_index account_index/user_index through bms-adapter
  let created;
  try {
    created = await deps.bms.createUser({
      organization: coupon.organization,
      instituteId: coupon.instituteId,
      username,
      firstName,
      lastName,
      password,
      email,
      openSimUserId,
      licenseId: coupon.licenseId,
    });
  } catch (err) {
    logger.error('Grid account exists without a BMS user: manual recovery needed', {
      username,
      openSimUserId,
      robustSkip: deps.robustSkip,
    });
    throw err;
  }

  if (!created.indexWriteSucceeded || !created.accountId) {
    // bms-adapter: BMS user exists, ew_index write failed → reconciliation, not a failed registration
    logger.error('BMS user created but ew_index write failed: reconciliation needed', {
      username,
      bmsUserId: created.userId,
      openSimUserId,
    });
  }

  logger.info('User registered', { username, accountId: created.accountId, organization: coupon.organization });
  return { accountId: created.accountId, username: created.username };
}
