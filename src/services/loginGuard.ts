import crypto from 'node:crypto';
import { logger } from '../utils/logger';

// Copied from ew-portal-api (services/loginGuard.ts): per (username, client IP) key,
// a sliding-window rate limit and a captcha trigger after consecutive failures.
// In-memory, per task (as in ew-portal-api).

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 10; // rate limit threshold
export const CAPTCHA_THRESHOLD = 3; // consecutive failures before captcha required

interface KeyState {
  attempts: { timestamp: number }[];
  failures: number;
}

export interface GuardCheckResult {
  blocked: boolean; // 429 — rate limit exceeded
  requiresCaptcha: boolean;
  retryAfterMs?: number;
}

export interface LoginGuard {
  deriveKey(username: string, ip: string): string;
  checkGuard(key: string): GuardCheckResult;
  recordAttempt(key: string): void;
  recordFailure(key: string): void;
  recordSuccess(key: string): void;
  getFailureCount(key: string): number;
}

export class MemoryLoginGuard implements LoginGuard {
  private readonly store = new Map<string, KeyState>();

  constructor() {
    // Periodic cleanup of expired windows (every 5 minutes); unref so it never keeps the process alive
    setInterval(() => {
      const now = Date.now();
      for (const [key, state] of this.store.entries()) {
        state.attempts = state.attempts.filter(a => now - a.timestamp < WINDOW_MS);
        if (state.attempts.length === 0 && state.failures === 0) this.store.delete(key);
      }
    }, 5 * 60 * 1000).unref();
  }

  deriveKey(username: string, ip: string): string {
    return crypto.createHash('sha256').update(`${username}:${ip}`).digest('hex');
  }

  private getState(key: string): KeyState {
    let state = this.store.get(key);
    if (!state) {
      state = { attempts: [], failures: 0 };
      this.store.set(key, state);
    }
    return state;
  }

  checkGuard(key: string): GuardCheckResult {
    const now = Date.now();
    const state = this.getState(key);
    state.attempts = state.attempts.filter(a => now - a.timestamp < WINDOW_MS);
    if (state.attempts.length >= MAX_ATTEMPTS) {
      const retryAfterMs = WINDOW_MS - (now - state.attempts[0].timestamp);
      return { blocked: true, requiresCaptcha: false, retryAfterMs };
    }
    return { blocked: false, requiresCaptcha: state.failures >= CAPTCHA_THRESHOLD };
  }

  recordAttempt(key: string): void {
    this.getState(key).attempts.push({ timestamp: Date.now() });
  }

  recordFailure(key: string): void {
    this.getState(key).failures += 1;
  }

  recordSuccess(key: string): void {
    this.store.delete(key); // reset both counters
  }

  getFailureCount(key: string): number {
    return this.store.get(key)?.failures ?? 0;
  }
}

// ── MFA code guard (0.5.0) ───────────────────────────────────────────────────
// Once the password is correct the login counters reset and no captcha is asked (Asaff,
// 2026-11-20: the captcha protects the username and password only). The 6-digit code gets its own
// limit instead, keyed on the user (not the IP), so it can't be spread over addresses:
// MFA_MAX_FAILURES wrong codes within MFA_WINDOW_MS → 429 until the oldest one leaves the window.
const MFA_WINDOW_MS = 15 * 60 * 1000;
export const MFA_MAX_FAILURES = 5;

export interface MfaGuard {
  check(userId: string): { blocked: boolean; retryAfterMs?: number };
  recordFailure(userId: string): void;
  reset(userId: string): void;
}

export class MemoryMfaGuard implements MfaGuard {
  private readonly failures = new Map<string, number[]>();

  constructor() {
    setInterval(() => {
      const now = Date.now();
      for (const [k, list] of this.failures.entries()) {
        const kept = list.filter(t => now - t < MFA_WINDOW_MS);
        if (kept.length === 0) this.failures.delete(k);
        else this.failures.set(k, kept);
      }
    }, 5 * 60 * 1000).unref();
  }

  private recent(userId: string): number[] {
    const now = Date.now();
    const list = (this.failures.get(userId.toLowerCase()) ?? []).filter(t => now - t < MFA_WINDOW_MS);
    this.failures.set(userId.toLowerCase(), list);
    return list;
  }

  check(userId: string): { blocked: boolean; retryAfterMs?: number } {
    const list = this.recent(userId);
    if (list.length < MFA_MAX_FAILURES) return { blocked: false };
    return { blocked: true, retryAfterMs: MFA_WINDOW_MS - (Date.now() - list[0]) };
  }

  recordFailure(userId: string): void {
    this.recent(userId).push(Date.now());
  }

  reset(userId: string): void {
    this.failures.delete(userId.toLowerCase());
  }
}

/** reCAPTCHA v2 verification (copied from ew-portal-api). Never logs the secret. */
export function recaptchaVerifier(secretKey: string): (token: string) => Promise<boolean> {
  return async (token: string) => {
    try {
      const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret: secretKey, response: token }).toString(),
        signal: AbortSignal.timeout(5000),
      });
      const data = (await res.json()) as { success?: boolean };
      return data.success === true;
    } catch (err) {
      logger.error('reCAPTCHA verification error', { message: (err as Error).message });
      return false;
    }
  };
}
