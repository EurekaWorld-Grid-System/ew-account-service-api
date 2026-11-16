import { authenticator } from 'otplib';
import QRCode from 'qrcode';

// TOTP (RFC 6238, Google Authenticator: SHA-1, 6 digits, 30 s) on the BMS DoubleAuths secret
// (Base32). The QR code is generated here, never by an external service (Asaff).

const STEP_SECONDS = 30;
const ISSUER = 'EurekaWorld';

authenticator.options = { window: 1, step: STEP_SECONDS, digits: 6 }; // ±1 step for clock drift

export const TOTP_RE = /^\d{6}$/;

/**
 * Checks a 6-digit code against the secret. Rejects a code from a time step at or before the
 * last successful verification, so a code can't be used twice.
 */
export function verifyTotp(code: string, secret: string, lastVerificationOn: string | null, now = Date.now()): boolean {
  if (!TOTP_RE.test(code)) return false;
  let delta: number | null;
  try {
    delta = authenticator.checkDelta(code, secret);
  } catch {
    return false; // malformed secret
  }
  if (delta === null) return false;
  if (lastVerificationOn) {
    const last = Date.parse(lastVerificationOn.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(lastVerificationOn) ? lastVerificationOn : `${lastVerificationOn}Z`);
    if (!Number.isNaN(last)) {
      const codeStep = Math.floor(now / 1000 / STEP_SECONDS) + delta;
      const lastStep = Math.floor(last / 1000 / STEP_SECONDS);
      if (codeStep <= lastStep) return false;
    }
  }
  return true;
}

/** otpauth:// URI for authenticator apps: label "EurekaWorld:<username>", issuer EurekaWorld. */
export function otpauthUri(username: string, secret: string): string {
  return authenticator.keyuri(username, ISSUER, secret);
}

/** PNG of the otpauth:// URI. */
export function qrPng(uri: string): Promise<Buffer> {
  return QRCode.toBuffer(uri, { type: 'png', width: 256, margin: 2, errorCorrectionLevel: 'M' });
}
