import crypto from 'node:crypto';

// Constant-time string comparison (API keys). Different lengths are compared
// through SHA-256 digests so the length itself doesn't leak through timing.
export function secureEquals(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}
