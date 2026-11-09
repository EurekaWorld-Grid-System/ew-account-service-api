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
    },
    grid: {
      nameExists: async names => names.some(n => s.gridNames.has(key(n))),
      findPrincipalId: async n => s.gridNames.get(key(n)) ?? null,
    },
    robust: {
      createAccount: async req => {
        s.robustCalls.push(req);
        if (s.robustFails) throw new AppError(502, 'REGISTRATION_FAILED', 'Grid account creation failed');
        if (s.robustCreatesRow) s.gridNames.set(`${req.first} ${req.last}`, 'bbbbbbbb-0000-0000-0000-000000000002');
      },
    },
    bms: {
      createUser: async req => {
        s.bmsCalls.push(req);
        if (s.bmsResult instanceof AppError) throw s.bmsResult;
        return s.bmsResult;
      },
    },
  };
}

export function testApp(s: FakeState = fakeState(), robustSkip = false) {
  return createApp({ apiKey: API_KEY, registration: fakeDeps(s, robustSkip) });
}
