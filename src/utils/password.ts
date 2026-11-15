import { AppError } from './errors';

// EurekaWorld password standard (Registration Wizard Architecture v1.0 §4, Pre-Launch Security
// Design §1.3, MoE-compliant): 10-128 characters, at least one English letter and one digit,
// only English letters, digits and !@#$%^&*().
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;
const PASSWORD_ALLOWED_RE = /^[A-Za-z0-9!@#$%^&*()]+$/;

export function meetsPasswordStandard(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length >= PASSWORD_MIN &&
    v.length <= PASSWORD_MAX &&
    PASSWORD_ALLOWED_RE.test(v) &&
    /[A-Za-z]/.test(v) &&
    /[0-9]/.test(v)
  );
}

/** Returns the password unchanged (never trimmed) or throws 400 VALIDATION_ERROR. */
export function parsePassword(v: unknown, field = 'password'): string {
  if (!meetsPasswordStandard(v)) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `${field} must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters of English letters, digits and !@#$%^&*(), ` +
        'with at least one letter and one digit'
    );
  }
  return v;
}
