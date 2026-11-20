import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ADMIN, API_KEY, fakeState, testApp, USER } from './fakes';

type State = ReturnType<typeof fakeState>;
const TOKEN = '33333333-3333-4333-8333-333333333333';

const change = (app: ReturnType<typeof testApp>, userId: string, b: Record<string, unknown>, key = API_KEY) =>
  request(app).put(`/users/${userId}/password`).set('X-Api-Key', key).send(b);

const reset = (app: ReturnType<typeof testApp>, userId: string, b: Record<string, unknown>, token?: string) => {
  const r = request(app).post(`/users/${userId}/password/reset`).set('X-Api-Key', API_KEY);
  if (token) r.set('X-Service-Token', token);
  return r.send(b);
};

const own = { actingUserId: USER, actingUserPassword: 'OldPassw0rd1', newPassword: 'NewPassw0rd2' };

describe('PUT /users/:userId/password (acting user proves their password)', () => {
  it('needs the caller X-Api-Key', async () => {
    const res = await change(testApp(), USER, own, 'nope');
    expect([res.status, res.body.code]).toEqual([401, 'INVALID_API_KEY']);
  });

  it('own change: BMS (isInitial false) then grid; 200 gridSync ok', async () => {
    const s = fakeState();
    const res = await change(testApp(s), USER, own);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'password_changed', gridSync: 'ok' });
    expect(s.passwordSets).toEqual([{ userId: USER, newPassword: 'NewPassw0rd2', isInitial: false }]);
    expect(s.gridPasswordSets).toEqual([{ principalId: 'aaaaaaaa-0000-0000-0000-000000000001', password: 'NewPassw0rd2' }]);
  });

  it('change by another user (admin/teacher) with isInitial: verifies the ACTING user password', async () => {
    const s = fakeState();
    const res = await change(testApp(s), USER, {
      actingUserId: ADMIN,
      actingUserPassword: 'AdminPassw0rd',
      newPassword: 'Initial12345',
      isInitial: true,
    });
    expect(res.status).toBe(200);
    expect(s.passwordSets).toEqual([{ userId: USER, newPassword: 'Initial12345', isInitial: true }]);

    const wrong = await change(testApp(fakeState()), USER, { actingUserId: ADMIN, actingUserPassword: 'OldPassw0rd1', newPassword: 'Initial12345' });
    expect([wrong.status, wrong.body.code]).toEqual([401, 'INVALID_ACTING_USER_PASSWORD']);
  });

  it('fails before any write', async () => {
    const cases: [string, Record<string, unknown>, number, string][] = [
      ['not-a-uuid', own, 400, 'VALIDATION_ERROR'],
      [USER, { ...own, actingUserId: 'x' }, 400, 'VALIDATION_ERROR'],
      [USER, { ...own, actingUserPassword: '' }, 400, 'VALIDATION_ERROR'],
      [USER, { ...own, newPassword: 'short1' }, 400, 'VALIDATION_ERROR'],
      [USER, { ...own, newPassword: 'Bad~Char123' }, 400, 'VALIDATION_ERROR'],
      [USER, { ...own, newPassword: 'OldPassw0rd1' }, 400, 'VALIDATION_ERROR'],
      [USER, { ...own, isInitial: 'yes' }, 400, 'VALIDATION_ERROR'],
      [USER, { ...own, actingUserPassword: 'WrongPass99' }, 401, 'INVALID_ACTING_USER_PASSWORD'],
      [USER, { ...own, actingUserId: '44444444-4444-4444-8444-444444444444' }, 401, 'INVALID_ACTING_USER_PASSWORD'],
      [USER, { ...own, newPassword: 'Recent12345' }, 400, 'PASSWORD_RECENTLY_USED'],
      ['55555555-5555-4555-8555-555555555555', { ...own, actingUserId: ADMIN, actingUserPassword: 'AdminPassw0rd' }, 404, 'USER_NOT_FOUND'],
    ];
    for (const [userId, b, status, code] of cases) {
      const s = fakeState();
      const res = await change(testApp(s), userId, b);
      expect([userId, res.status, res.body.code]).toEqual([userId, status, code]);
      expect(s.passwordSets).toHaveLength(0);
      expect(s.gridPasswordSets).toHaveLength(0);
    }
  });

  it('Robust failure after BMS success → 200 gridSync failed, GRID_PASSWORD_SYNC_FAILED', async () => {
    const s = fakeState();
    s.robustPasswordFails = true;
    const res = await change(testApp(s), USER, own);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'password_changed', gridSync: 'failed', code: 'GRID_PASSWORD_SYNC_FAILED' });
    expect(s.passwordSets).toHaveLength(1);
  });

  it('no grid account (no open_sim_user_id, or not in useraccounts) → Robust not called', async () => {
    for (const mutate of [(s: State) => (s.users.get(USER)!.openSimUserId = null), (s: State) => s.gridNames.clear()]) {
      const s = fakeState();
      mutate(s);
      const res = await change(testApp(s), USER, own);
      expect(res.body).toMatchObject({ gridSync: 'failed', code: 'GRID_PASSWORD_SYNC_FAILED' });
      expect(s.gridPasswordSets).toHaveLength(0);
    }
  });

  it('ROBUST_SKIP: grid sync skipped', async () => {
    const s = fakeState();
    expect((await change(testApp(s, true), USER, own)).body).toEqual({ status: 'password_changed', gridSync: 'skipped' });
    expect(s.gridPasswordSets).toHaveLength(0);
  });
});

describe('POST /users/:userId/password/reset (forgot-password, system:set-password token)', () => {
  const withToken = (s: State, action = 'system:set-password', subjectUserId = USER) =>
    s.serviceTokens.push({ tokenId: TOKEN, action, subjectUserId });

  it('valid token: sets the password (isInitial false) and the grid password; token is one-time', async () => {
    const s = fakeState();
    withToken(s);
    const app = testApp(s);
    const res = await reset(app, USER, { newPassword: 'NewPassw0rd2' }, TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'password_changed', gridSync: 'ok' });
    expect(s.passwordSets).toEqual([{ userId: USER, newPassword: 'NewPassw0rd2', isInitial: false }]);

    const again = await reset(app, USER, { newPassword: 'NewPassw0rd3' }, TOKEN);
    expect([again.status, again.body.code]).toEqual([403, 'INVALID_SERVICE_TOKEN']);
  });

  it('missing, wrong-action or other-user tokens → 403 INVALID_SERVICE_TOKEN, nothing written', async () => {
    const variants: [(s: State) => void, string | undefined][] = [
      [s => withToken(s), undefined],
      [s => withToken(s, 'deactivate'), TOKEN],
      [s => withToken(s, 'system:set-password', ADMIN), TOKEN],
      [() => undefined, TOKEN],
    ];
    for (const [setup, token] of variants) {
      const s = fakeState();
      setup(s);
      const res = await reset(testApp(s), USER, { newPassword: 'NewPassw0rd2' }, token);
      expect([res.status, res.body.code]).toEqual([403, 'INVALID_SERVICE_TOKEN']);
      expect(s.passwordSets).toHaveLength(0);
    }
  });

  it('weak or reused new password is refused', async () => {
    let s = fakeState();
    withToken(s);
    expect((await reset(testApp(s), USER, { newPassword: 'weak' }, TOKEN)).body.code).toBe('VALIDATION_ERROR');
    s = fakeState();
    withToken(s);
    expect((await reset(testApp(s), USER, { newPassword: 'Recent12345' }, TOKEN)).body.code).toBe('PASSWORD_RECENTLY_USED');
    expect(s.passwordSets).toHaveLength(0);
  });
});
