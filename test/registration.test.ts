import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { AppError } from '../src/utils/errors';
import { API_KEY, fakeState, testApp } from './fakes';

const valid = {
  couponCode: 'EW12345678X',
  username: 'jsmith',
  firstName: 'John',
  lastName: 'Smith',
  email: 'John@Example.com',
  password: 'secret123',
  avatarCode: 'Glen',
};

const post = (app: ReturnType<typeof testApp>, path: string, body: unknown) =>
  request(app).post(path).set('X-Api-Key', API_KEY).send(body as object);

describe('caller authentication', () => {
  it('rejects a missing or wrong X-Api-Key with 401', async () => {
    const app = testApp();
    expect((await request(app).post('/registration').send(valid)).status).toBe(401);
    const res = await request(app).post('/registration/validate-coupon').set('X-Api-Key', 'nope').send({ couponCode: 'x' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_API_KEY');
  });
});

describe('pre-flight endpoints', () => {
  const app = testApp();

  it('validate-coupon: 200 with license and institute, 404 when unknown', async () => {
    const ok = await post(app, '/registration/validate-coupon', { couponCode: ' EW12345678X ' });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ valid: true, licenseId: 'lic-1', instituteId: 'inst-1' });
    const bad = await post(app, '/registration/validate-coupon', { couponCode: 'NOPE' });
    expect(bad.status).toBe(404);
    expect(bad.body.code).toBe('COUPON_NOT_FOUND');
  });

  it('validate-email: lower-cases, 409 when registered, 400 when malformed', async () => {
    expect((await post(app, '/registration/validate-email', { email: 'new@example.com' })).body).toEqual({ available: true });
    const taken = await post(app, '/registration/validate-email', { email: 'TAKEN@example.com' });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('EMAIL_ALREADY_IN_USE');
    expect((await post(app, '/registration/validate-email', { email: 'nope' })).body.code).toBe('VALIDATION_ERROR');
  });

  it('validate-username: index and grid (EW and legacy Resident) conflicts', async () => {
    expect((await post(app, '/registration/validate-username', { username: 'fresh' })).status).toBe(200);
    expect((await post(app, '/registration/validate-username', { username: 'taken' })).status).toBe(409);
    const legacy = await post(app, '/registration/validate-username', { username: 'oldtimer' });
    expect(legacy.status).toBe(409);
    expect(legacy.body.code).toBe('USERNAME_ALREADY_IN_USE');
  });

  it('validate-username: two-word usernames are checked as that exact grid name', async () => {
    const s = fakeState();
    s.gridNames.set('John Smith', 'cccccccc-0000-0000-0000-000000000003');
    const a = testApp(s);
    expect((await post(a, '/registration/validate-username', { username: 'John  Smith' })).status).toBe(409);
    expect((await post(a, '/registration/validate-username', { username: 'John Smyth' })).status).toBe(200);
    // "John" alone maps to "John EW" / "John Resident", not "John Smith"
    expect((await post(a, '/registration/validate-username', { username: 'John' })).status).toBe(200);
  });

  it('validate-username: one or two words of [A-Za-z0-9_], second word not EW/Resident', async () => {
    for (const username of ['three word name', 'dash-ed', 'עברית', '', 'john EW', 'john resident']) {
      expect((await post(app, '/registration/validate-username', { username })).body.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('POST /registration', () => {
  it('creates the grid account as "<username> EW" with an empty email, then the BMS user', async () => {
    const s = fakeState();
    const res = await post(testApp(s), '/registration', valid);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ accountId: 'acc-1', username: 'jsmith' });

    expect(s.robustCalls).toEqual([{ first: 'jsmith', last: 'EW', password: 'secret123', avatar: 'Glen' }]);
    expect(s.bmsCalls).toEqual([
      {
        organization: 'general',
        instituteId: 'inst-1',
        username: 'jsmith',
        firstName: 'John',
        lastName: 'Smith',
        password: 'secret123',
        email: 'john@example.com',
        openSimUserId: 'bbbbbbbb-0000-0000-0000-000000000002',
        licenseId: 'lic-1',
      },
    ]);
  });

  it('a two-word username becomes that grid name (no EW)', async () => {
    const s = fakeState();
    const res = await post(testApp(s), '/registration', { ...valid, username: 'John Smith' });
    expect(res.status).toBe(201);
    expect(s.robustCalls[0]).toMatchObject({ first: 'John', last: 'Smith' });
    expect(s.bmsCalls[0].username).toBe('John Smith');
  });

  it('email is optional (sent to bms-adapter as null)', async () => {
    const s = fakeState();
    const res = await post(testApp(s), '/registration', { ...valid, email: '' });
    expect(res.status).toBe(201);
    expect(s.bmsCalls[0].email).toBeNull();
  });

  it('fails fast in order, before Robust is called', async () => {
    const cases: [Record<string, unknown>, number, string][] = [
      [{ password: 'short' }, 400, 'VALIDATION_ERROR'],
      [{ couponCode: 'NOPE' }, 404, 'COUPON_NOT_FOUND'],
      [{ email: 'taken@example.com' }, 409, 'EMAIL_ALREADY_IN_USE'],
      [{ username: 'oldtimer' }, 409, 'USERNAME_ALREADY_IN_USE'],
      [{ avatarCode: 'Nobody' }, 400, 'INVALID_AVATAR_CODE'],
    ];
    for (const [override, status, code] of cases) {
      const s = fakeState();
      const res = await post(testApp(s), '/registration', { ...valid, ...override });
      expect([res.status, res.body.code]).toEqual([status, code]);
      expect(s.robustCalls).toHaveLength(0);
      expect(s.bmsCalls).toHaveLength(0);
    }
  });

  it('Robust failure → 502 REGISTRATION_FAILED, no BMS call', async () => {
    const s = fakeState();
    s.robustFails = true;
    const res = await post(testApp(s), '/registration', valid);
    expect([res.status, res.body.code]).toEqual([502, 'REGISTRATION_FAILED']);
    expect(s.bmsCalls).toHaveLength(0);
  });

  it('grid account missing after Robust → 502 USER_LOOKUP_FAILED, no BMS call', async () => {
    const s = fakeState();
    s.robustCreatesRow = false;
    const res = await post(testApp(s), '/registration', valid);
    expect([res.status, res.body.code]).toEqual([502, 'USER_LOOKUP_FAILED']);
    expect(s.bmsCalls).toHaveLength(0);
  });

  it('bms-adapter failure is passed through (502 BMS_REGISTRATION_FAILED)', async () => {
    const s = fakeState();
    s.bmsResult = new AppError(502, 'BMS_REGISTRATION_FAILED', 'BMS user creation failed');
    const res = await post(testApp(s), '/registration', valid);
    expect([res.status, res.body.code]).toEqual([502, 'BMS_REGISTRATION_FAILED']);
  });

  it('index write failure in bms-adapter still returns 201 with accountId null', async () => {
    const s = fakeState();
    s.bmsResult = { userId: 'bms-user-1', username: 'jsmith', accountId: null, indexWriteSucceeded: false };
    const res = await post(testApp(s), '/registration', valid);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ accountId: null, username: 'jsmith' });
  });

  it('ROBUST_SKIP: no Robust call, random UUID as openSimUserId, bms-adapter still called', async () => {
    const s = fakeState();
    const res = await post(testApp(s, true), '/registration', valid);
    expect(res.status).toBe(201);
    expect(s.robustCalls).toHaveLength(0);
    expect(s.bmsCalls).toHaveLength(1);
    expect(s.bmsCalls[0].openSimUserId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
