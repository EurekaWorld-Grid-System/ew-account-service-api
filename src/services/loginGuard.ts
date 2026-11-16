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
