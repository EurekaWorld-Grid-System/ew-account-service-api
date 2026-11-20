import crypto from 'node:crypto';
import { createApp } from '../src/app';
import { MemoryLoginGuard, MemoryMfaGuard } from '../src/services/loginGuard';
import { TokenIssuer } from '../src/services/tokens';
import { AppError } from '../src/utils/errors';
import {
  BmsCreatedUser,
  BmsCreateUser,
  CouponInfo,
  GridName,
  IndexedUser,
  RegistrationDeps,
  RobustCreateAccount,
} from '../src/services/types';

export const API_KEY = 'test-key';
export const USER = '11111111-1111-4111-8111-111111111111';
export const ADMIN = '22222222-2222-4222-8222-222222222222';

export interface FakeState {
  coupons: Record<string, CouponInfo>;
  emails: Set<string>;
  usernames: Set<string>;
  avatars: Set<string>;
  gridNames: Map<string, string>; // "First Last" -> PrincipalID
  robustCalls: RobustCreateAccount[];
  bmsCalls: BmsCreateUser[];
  robustFails: boolean;
  robustCreatesRow: boolean;
  bmsResult: BmsCreatedUser | AppError;
  // Passwords
  users: Map<string, IndexedUser>; // BMS userId -> user_index row
  credentials: Map<string, { password: string; salt: string }>; // BMS userId -> current password
  serviceTokens: { tokenId: string; action: string; subjectUserId: string }[];
  recentPasswords: Set<string>;
  passwordSets: { userId: string; newPassword: string; isInitial: boolean }[];
  gridPasswordSets: { principalId: string; password: string }[];
  robustPasswordFails: boolean;
  // Login / MFA
  mfa: Map<string, { secret: string; isInitial: boolean; lastVerificationOn: string | null }>; // userId -> active secret
  mfaVerified: string[];
  migrated: Set<string>; // usernames BmsLoginFallback can migrate
  captchaOk: boolean;
  mfaSecretMissing: boolean; // UseDoubleAuth set but no active DoubleAuths row
  // Sessions (ew_system.auth_sessions)
  sessions: Map<string, FakeSession>;
}

export interface FakeSession {
  userId: string;
  refreshJti: string;
  previousJti: string | null;
  rotatedAt: number | null; // ms
  expiresAt: number; // ms
  revokedReason: string | null;
  clientIp: string | null;
}

export function fakeState(): FakeState {
  return {
    coupons: {
      EW12345678X: { licenseId: 'lic-1', instituteId: 'inst-1', instituteName: 'Test School', organization: 'general' },
    },
    emails: new Set(['taken@example.com']),
    usernames: new Set(['taken']),
    avatars: new Set(['Glen']),
    gridNames: new Map([['oldtimer Resident', 'aaaaaaaa-0000-0000-0000-000000000001']]),
    robustCalls: [],
    bmsCalls: [],
    robustFails: false,
    robustCreatesRow: true,
    bmsResult: { userId: 'bms-user-1', username: 'jsmith', accountId: 'acc-1', indexWriteSucceeded: true },
    users: new Map(
      [
        [USER, 'jdoe', 'acc-9', 'aaaaaaaa-0000-0000-0000-000000000001'],
        [ADMIN, 'boss', 'acc-1', null],
      ].map(([userId, username, accountId, openSimUserId]) => [
        userId as string,
        {
          userId: userId as string,
          username: username as string,
          accountId: accountId as string,
          instituteId: 'inst-1',
          organization: 'general' as const,
          openSimUserId: openSimUserId as string | null,
        },
      ])
    ),
    credentials: new Map([
      [USER, { password: 'OldPassw0rd1', salt: 's9' }],
      [ADMIN, { password: 'AdminPassw0rd', salt: 's1' }],
    ]),
    serviceTokens: [],
    recentPasswords: new Set(['Recent12345']),
    passwordSets: [],
    gridPasswordSets: [],
    robustPasswordFails: false,
    mfa: new Map(),
    mfaVerified: [],
    migrated: new Set(),
    captchaOk: true,
    mfaSecretMissing: false,
    sessions: new Map(),
  };
}

const key = (n: GridName) => `${n.firstName} ${n.lastName}`;

export function fakeDeps(s: FakeState, robustSkip = false): RegistrationDeps {
  return {
    robustSkip,
    system: {
      consumeServiceToken: async tokenId => {
        const i = s.serviceTokens.findIndex(t => t.tokenId === tokenId);
        if (i < 0) return null;
        const [t] = s.serviceTokens.splice(i, 1);
        return { action: t.action, subjectUserId: t.subjectUserId, actingUserId: t.subjectUserId };
      },
      // Same rules as db/ew_system_auth_sessions.sql
      createSession: async n => {
        s.sessions.set(n.sessionId, {
          userId: n.userId,
          refreshJti: n.refreshJti,
          previousJti: null,
          rotatedAt: null,
          expiresAt: Date.now() + n.ttlSeconds * 1000,
          revokedReason: null,
          clientIp: n.clientIp,
        });
      },
      rotateSession: async (sid, presented, newJti, ttl, grace) => {
        const x = s.sessions.get(sid);
        if (!x) return { result: 'NOT_FOUND', userId: null, refreshJti: null };
        const none = { userId: x.userId, refreshJti: null };
        if (x.revokedReason) return { result: 'REVOKED', ...none };
        if (x.expiresAt <= Date.now()) return { result: 'EXPIRED', ...none };
        if (x.refreshJti === presented) {
          Object.assign(x, { previousJti: x.refreshJti, refreshJti: newJti, rotatedAt: Date.now(), expiresAt: Date.now() + ttl * 1000 });
          return { result: 'OK', userId: x.userId, refreshJti: newJti };
        }
        if (x.previousJti === presented && x.rotatedAt !== null && x.rotatedAt > Date.now() - grace * 1000) {
          return { result: 'GRACE', userId: x.userId, refreshJti: x.refreshJti };
        }
        x.revokedReason = 'reuse';
        return { result: 'REUSED', ...none };
      },
      isSessionActive: async sid => {
        const x = s.sessions.get(sid);
        return !!x && !x.revokedReason && x.expiresAt > Date.now();
      },
      revokeUserSessions: async (userId, reason) => {
        let n = 0;
        for (const x of s.sessions.values()) {
          if (x.userId.toLowerCase() === userId.toLowerCase() && !x.revokedReason && x.expiresAt > Date.now()) {
            x.revokedReason = reason;
            n++;
          }
        }
        return n;
      },
      revokeSession: async (sid, reason) => {
        const x = s.sessions.get(sid);
        if (!x || x.revokedReason) return false;
        x.revokedReason = reason;
        return true;
      },
    },
    index: {
      findCoupon: async c => s.coupons[c] ?? null,
      emailExists: async e => s.emails.has(e),
      usernameExists: async u => s.usernames.has(u),
      avatarCodeExists: async a => s.avatars.has(a),
      findUser: async id => s.users.get(id) ?? null,
      findSessionUser: async id => {
        const u = s.users.get(id);
        return u ? { accountId: u.accountId, username: u.username, userId: u.userId, instituteId: u.instituteId, organization: 'general' } : null;
      },
      findLoginUser: async username => {
        const u = [...s.users.values()].find(x => x.username === username);
        if (!u || (username === 'late' && !s.migrated.has('done'))) return null;
        return { accountId: u.accountId, username: u.username, userId: u.userId, instituteId: u.instituteId, organization: 'general' };
      },
    },
    grid: {
      nameExists: async names => names.some(n => s.gridNames.has(key(n))),
      findPrincipalId: async n => s.gridNames.get(key(n)) ?? null,
      principalExists: async id => [...s.gridNames.values()].includes(id),
    },
    robust: {
      createAccount: async req => {
        s.robustCalls.push(req);
        if (s.robustFails) throw new AppError(502, 'REGISTRATION_FAILED', 'Grid account creation failed');
        if (s.robustCreatesRow) s.gridNames.set(`${req.first} ${req.last}`, 'bbbbbbbb-0000-0000-0000-000000000002');
      },
      setPassword: async (principalId, password) => {
        if (s.robustPasswordFails) throw new AppError(502, 'GRID_PASSWORD_SYNC_FAILED', 'Grid password update failed');
        s.gridPasswordSets.push({ principalId, password });
      },
    },
    bms: {
      createUser: async req => {
        s.bmsCalls.push(req);
        if (s.bmsResult instanceof AppError) throw s.bmsResult;
        return s.bmsResult;
      },
      // fake hash: "h(<password>:<salt>)"
      getCredentials: async u => {
        const c = s.credentials.get(u.userId);
        if (!c) return null;
        const m = s.mfa.get(u.userId);
        return {
          hashCode: `h(${c.password}:${c.salt})`,
          salt: c.salt,
          isInitial: false,
          globalRole: u.userId === ADMIN ? 'Teacher' : 'User',
          hasMfa: !!m,
          mfaIsInitial: !!m?.isInitial,
        };
      },
      migrateByUsername: async username => {
        if (!s.migrated.has(username)) return false;
        s.migrated.add('done');
        return true;
      },
      getMfa: async u => {
        const m = s.mfa.get(u.userId);
        return m && !s.mfaSecretMissing ? { authCode: m.secret, lastVerificationOn: m.lastVerificationOn } : null;
      },
      markMfaVerified: async u => {
        s.mfaVerified.push(u.userId);
        const m = s.mfa.get(u.userId);
        if (m) {
          m.isInitial = false;
          m.lastVerificationOn = new Date().toISOString();
        }
      },
      computeHash: async (password, salt) => `h(${password}:${salt})`,
      isPasswordAllowed: async (_u, p) => !s.recentPasswords.has(p),
      setPassword: async (u, newPassword, isInitial) => {
        s.passwordSets.push({ userId: u.userId, newPassword, isInitial });
      },
    },
  };
}

// Test RS256 key pair, standing in for the key pair shared with ew-portal-api
export const keys = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

export function testApp(s: FakeState = fakeState(), robustSkip = false) {
  const deps = fakeDeps(s, robustSkip);
  return createApp({
    apiKey: API_KEY,
    registration: deps,
    login: {
      index: deps.index,
      bms: deps.bms,
      system: deps.system,
      guard: new MemoryLoginGuard(),
      mfaGuard: new MemoryMfaGuard(),
      verifyCaptcha: async () => s.captchaOk,
      tokens: new TokenIssuer({
        privateKey: keys.privateKey,
        accessTokenExpiry: '15m',
        refreshTokenExpiry: '12h',
        cookieDomain: '.example.test',
        secureCookies: true,
      }),
      bmsLoginFallback: true,
    },
  });
}
