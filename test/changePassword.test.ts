import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { accessToken, API_KEY, fakeState, testApp } from './fakes';

const body = { oldPassword: 'OldPassw0rd1', newPassword: 'NewPassw0rd2' };

const call = (app: ReturnType<typeof testApp>, b: unknown = body, token: string | null = accessToken(), key = API_KEY) => {
  const r = request(app).post('/account/change-password').set('X-Api-Key', key);
  if (token !== null) r.set('Authorization', `Bearer ${token}`);
  return r.send(b as object);
};

describe('POST /account/change-password: authentication', () => {
  it('needs the caller X-Api-Key', async () => {
    const res = await call(testApp(), body, accessToken(), 'nope');
    expect([res.status, res.body.code]).toEqual([401, 'INVALID_API_KEY']);
  });

  it('needs a Bearer access token (TOKEN_INVALID)', async () => {
    const res = await call(testApp(), body, null);
    expect([res.status, res.body.code]).toEqual([401, 'TOKEN_INVALID']);
  });

  it('expired token → TOKEN_EXPIRED', async () => {
    const t = accessToken({ exp: Math.floor(Date.now() / 1000) - 10 }, {});
    const res = await call(testApp(), body, t);
    expect([res.status, res.body.code]).toEqual([401, 'TOKEN_EXPIRED']);
  });

  it('rejects refresh/challenge tokens (type claim) and tokens signed with another key', async () => {
    const refresh = accessToken({ type: 'refresh' });
    expect((await call(testApp(), body, refresh)).body.code).toBe('TOKEN_INVALID');

    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const forged = jwt.sign({ sub: 'bms-user-9', accountId: 'a', organization: 'general', instituteId: 'i' }, other, {
      algorithm: 'RS256',
    });
    expect((await call(testApp(), body, forged)).body.code).toBe('TOKEN_INVALID');
  });
});

describe('POST /account/change-password: flow', () => {
  it('changes BMS then the grid password; 200 gridSync ok', async () => {
    const s = fakeState();
    const res = await call(testApp(s));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'password_changed', gridSync: 'ok' });
    expect(s.passwordSets).toEqual([{ userId: 'bms-user-9', newPassword: 'NewPassw0rd2' }]);
    expect(s.gridPasswordSets).toEqual([{ principalId: 'aaaaaaaa-0000-0000-0000-000000000001', password: 'NewPassw0rd2' }]);
  });

  it('validation and BMS errors stop before anything changes', async () => {
    const cases: [Record<string, unknown>, number, string][] = [
      [{ oldPassword: '' }, 400, 'VALIDATION_ERROR'],
      [{ newPassword: 'short1' }, 400, 'VALIDATION_ERROR'],
      [{ newPassword: 'NoDigitsHere' }, 400, 'VALIDATION_ERROR'],
      [{ newPassword: 'Bad~Char123' }, 400, 'VALIDATION_ERROR'],
      [{ newPassword: 'OldPassw0rd1' }, 400, 'VALIDATION_ERROR'],
      [{ oldPassword: 'WrongPass99' }, 401, 'WRONG_CURRENT_PASSWORD'],
      [{ newPassword: 'Recent12345' }, 400, 'PASSWORD_RECENTLY_USED'],
    ];
    for (const [override, status, code] of cases) {
      const s = fakeState();
      const res = await call(testApp(s), { ...body, ...override });
      expect([res.status, res.body.code]).toEqual([status, code]);
      expect(s.passwordSets).toHaveLength(0);
      expect(s.gridPasswordSets).toHaveLength(0);
    }
  });

  it('unknown BMS user → 404 USER_NOT_FOUND', async () => {
    const res = await call(testApp(), body, accessToken({ sub: 'nobody' }));
    expect([res.status, res.body.code]).toEqual([404, 'USER_NOT_FOUND']);
  });

  it('Robust failure after BMS success → 200 gridSync failed, GRID_PASSWORD_SYNC_FAILED', async () => {
    const s = fakeState();
    s.robustPasswordFails = true;
    const res = await call(testApp(s));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'password_changed', gridSync: 'failed', code: 'GRID_PASSWORD_SYNC_FAILED' });
    expect(s.passwordSets).toHaveLength(1);
  });

  it('no grid account (no open_sim_user_id, or not in useraccounts) → Robust is not called', async () => {
    for (const mutate of [
      (s: ReturnType<typeof fakeState>) => s.openSimUserIds.clear(),
      (s: ReturnType<typeof fakeState>) => s.gridNames.clear(),
    ]) {
      const s = fakeState();
      mutate(s);
      const res = await call(testApp(s));
      expect(res.body).toMatchObject({ gridSync: 'failed', code: 'GRID_PASSWORD_SYNC_FAILED' });
      expect(s.gridPasswordSets).toHaveLength(0);
    }
  });

  it('ROBUST_SKIP: BMS changed, grid sync skipped', async () => {
    const s = fakeState();
    const res = await call(testApp(s, true));
    expect(res.body).toEqual({ status: 'password_changed', gridSync: 'skipped' });
    expect(s.gridPasswordSets).toHaveLength(0);
  });
});
