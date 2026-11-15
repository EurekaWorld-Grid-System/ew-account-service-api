import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app';
import { AppError } from '../src/utils/errors';
import {
  BmsCreatedUser,
  BmsCreateUser,
  CouponInfo,
  GridName,
  RegistrationDeps,
  RobustCreateAccount,
} from '../src/services/types';

export const API_KEY = 'test-key';

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
  // Password change
  openSimUserIds: Map<string, string>; // BMS userId -> open_sim_user_id
  credentials: Map<string, { password: string; salt: string }>; // BMS userId -> current password
  recentPasswords: Set<string>;
  passwordSets: { userId: string; newPassword: string }[];
  gridPasswordSets: { principalId: string; password: string }[];
  robustPasswordFails: boolean;
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
    openSimUserIds: new Map([['bms-user-9', 'aaaaaaaa-0000-0000-0000-000000000001']]),
    credentials: new Map([['bms-user-9', { password: 'OldPassw0rd1', salt: 's9' }]]),
    recentPasswords: new Set(['Recent12345']),
    passwordSets: [],
    gridPasswordSets: [],
    robustPasswordFails: false,
  };
}

const key = (n: GridName) => `${n.firstName} ${n.lastName}`;

export function fakeDeps(s: FakeState, robustSkip = false): RegistrationDeps {
  return {
    robustSkip,
    index: {
      findCoupon: async c => s.coupons[c] ?? null,
      emailExists: async e => s.emails.has(e),
      usernameExists: async u => s.usernames.has(u),
      avatarCodeExists: async a => s.avatars.has(a),
      findOpenSimUserId: async id => s.openSimUserIds.get(id) ?? null,
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
        return c ? { hashCode: `h(${c.password}:${c.salt})`, salt: c.salt } : null;
      },
      computeHash: async (password, salt) => `h(${password}:${salt})`,
      isPasswordAllowed: async (_u, p) => !s.recentPasswords.has(p),
      setPassword: async (u, newPassword) => {
        s.passwordSets.push({ userId: u.userId, newPassword });
      },
    },
  };
}

// Test RS256 key pair, standing in for the shared ew-portal-api key pair
export const keys = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/** An ew-portal-api-style access token (claims as in its JwtPayload). */
export function accessToken(claims: Record<string, unknown> = {}, opts: jwt.SignOptions = { expiresIn: '15m' }): string {
  return jwt.sign(
    {
      sub: 'bms-user-9',
      accountId: 'acc-9',
      username: 'jdoe',
      globalRole: 'user',
      organization: 'general',
      instituteId: 'inst-1',
      isInitial: false,
      ...claims,
    },
    keys.privateKey,
    { algorithm: 'RS256', ...opts }
  );
}

export function testApp(s: FakeState = fakeState(), robustSkip = false) {
  return createApp({ apiKey: API_KEY, jwtPublicKey: keys.publicKey, registration: fakeDeps(s, robustSkip) });
}
