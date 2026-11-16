import { authenticator } from 'otplib';
import QRCode from 'qrcode';

// TOTP (RFC 6238, Google Authenticator: SHA-1, 6 digits, 30 s) on the BMS DoubleAuths secret.
// The QR code is generated here, never by an external service (Asaff).
//
// BMS stores DoubleAuths.AuthCode as plain text (e.g. "1234509876"), not Base32: the HMAC key is
// the text's UTF-8 bytes, as in the .NET Google Authenticator library BMS used. Authenticator apps
// and otplib take Base32, so the stored text is always Base32-encoded first (authCodeToBase32).

const STEP_SECONDS = 30;
const ISSUER = 'EurekaWorld';

authenticator.options = { window: 1, step: STEP_SECONDS, digits: 6 }; // ±1 step for clock drift

export const TOTP_RE = /^\d{6}$/;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 Base32 (no padding) of the AuthCode's UTF-8 bytes: the secret apps and otplib use. */
export function authCodeToBase32(authCode: string): string {
  const bytes = Buffer.from(authCode, 'utf8');
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Checks a 6-digit code against the secret. Rejects a code from a time step at or before the
 * last successful verification, so a code can't be used twice.
 */
export function verifyTotp(code: string, authCode: string, lastVerificationOn: string | null, now = Date.now()): boolean {
  if (!TOTP_RE.test(code)) return false;
  let delta: number | null;
  try {
    delta = authenticator.checkDelta(code, authCodeToBase32(authCode));
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
export function otpauthUri(username: string, authCode: string): string {
  return authenticator.keyuri(username, ISSUER, authCodeToBase32(authCode));
}

/** PNG of the otpauth:// URI. */
export function qrPng(uri: string): Promise<Buffer> {
  return QRCode.toBuffer(uri, { type: 'png', width: 256, margin: 2, errorCorrectionLevel: 'M' });
}
