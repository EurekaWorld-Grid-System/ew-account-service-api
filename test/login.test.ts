import jwt from 'jsonwebtoken';
import { authenticator } from 'otplib';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { verifyTotp } from '../src/services/totp';
import { ADMIN, API_KEY, fakeState, keys, testApp, USER } from './fakes';

const SECRET = authenticator.generateSecret();
const creds = { username: 'jdoe', password: 'OldPassw0rd1' };

const login = (app: ReturnType<typeof testApp>, b: Record<string, unknown>, ip = '203.0.113.7') =>
  request(app).post('/auth/login').set('X-Api-Key', API_KEY).set('X-Forwarded-For', `${ip}, 10.0.0.1`).send(b);

const withMfa = (isInitial: boolean, lastVerificationOn: string | null = null) => {
  const s = fakeState();
  s.mfa.set(USER, { secret: SECRET, isInitial, lastVerificationOn });
  return s;
};

describe('POST /auth/login (copied from ew-portal-api)', () => {
  it('needs the caller X-Api-Key', async () => {
    const res = await request(testApp()).post('/auth/login').send(creds);
    expect([res.status, res.body.code]).toEqual([401, 'INVALID_API_KEY']);
  });

  it('no MFA: access token (same claims) + refresh cookie on the root domain', async () => {
    const res = await login(testApp(), creds);
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({
      userId: USER,
      accountId: 'acc-9',
      username: 'jdoe',
      globalRole: 'user',
      organization: 'general',
      instituteId: 'inst-1',
      isInitial: false,
    });
    const claims = jwt.verify(res.body.accessToken, keys.publicKey, { algorithms: ['RS256'] }) as Record<string, unknown>;
    expect(claims).toMatchObject({ sub: USER, accountId: 'acc-9', globalRole: 'user', organization: 'general' });
    expect(claims.type).toBeUndefined();
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/ewRefreshToken=/);
    expect(cookie).toMatch(/Domain=\.example\.test/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const refresh = jwt.verify(decodeURIComponent(cookie.split('ewRefreshToken=')[1].split(';')[0]), keys.publicKey) as Record<string, unknown>;
    expect(refresh).toMatchObject({ sub: USER, type: 'refresh' });
  });

  it('wrong password / unknown user → 401 INVALID_CREDENTIALS; captcha after 3 failures', async () => {
    const app = testApp();
    for (let i = 1; i <= 3; i++) {
      const res = await login(app, { ...creds, password: 'nope' });
      expect([res.status, res.body.code]).toEqual([401, 'INVALID_CREDENTIALS']);
      expect(res.body.requiresCaptcha).toBe(i >= 3 ? true : undefined);
    }
    expect((await login(app, creds)).body.code).toBe('CAPTCHA_REQUIRED');
    expect((await login(app, { ...creds, captchaToken: 't' })).status).toBe(200);
    expect((await login(app, { username: 'ghost', password: 'x' })).body.code).toBe('INVALID_CREDENTIALS');
  });

  it('rate limit: after 10 failed attempts in 15 min from the same IP → 429 with Retry-After (as ew-portal-api)', async () => {
    const app = testApp();
    for (let i = 0; i < 10; i++) await login(app, { ...creds, password: 'nope', captchaToken: 't' });
    const res = await login(app, { ...creds, captchaToken: 't' });
    expect([res.status, res.body.code]).toEqual([429, 'RATE_LIMITED']);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect((await login(app, creds, '198.51.100.9')).status).toBe(200); // another IP
  });

  it('BmsLoginFallback: migrates an unknown username, then logs in', async () => {
    const s = fakeState();
    s.users.get(USER)!.username = 'late';
    s.migrated.add('late');
    const res = await login(testApp(s), { username: 'late', password: 'OldPassw0rd1' });
    expect(res.status).toBe(200);
  });
});

describe('POST /auth/login: MFA', () => {
  it('MFA user without mfaToken → 200 { status: MFA_REQUIRED }, no tokens or cookie', async () => {
    const res = await login(testApp(withMfa(false, '2026-01-01T00:00:00Z')), creds);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'MFA_REQUIRED' });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('never-verified secret → MFA_INITIAL', async () => {
    expect((await login(testApp(withMfa(true)), creds)).body).toEqual({ status: 'MFA_INITIAL' });
  });

  it('valid code → tokens, and bms-adapter marks the secret verified (also ends MFA_INITIAL)', async () => {
    const s = withMfa(true);
    const res = await login(testApp(s), { ...creds, mfaToken: authenticator.generate(SECRET) });
    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    expect(s.mfaVerified).toEqual([USER]);
    expect(s.mfa.get(USER)!.isInitial).toBe(false);
  });

  it('wrong code → 401 INVALID_MFA_TOKEN (counts as a failure), nothing marked', async () => {
    const s = withMfa(false, '2026-01-01T00:00:00Z');
    const app = testApp(s);
    const res = await login(app, { ...creds, mfaToken: '000000' === authenticator.generate(SECRET) ? '111111' : '000000' });
    expect([res.status, res.body.code, res.body.status]).toEqual([401, 'INVALID_MFA_TOKEN', 'MFA_REQUIRED']);
    expect(s.mfaVerified).toHaveLength(0);
    expect((await login(app, { ...creds, mfaToken: 'abc' })).body.code).toBe('INVALID_MFA_TOKEN');
  });

  it('a code can not be reused within its time step', async () => {
    const s = withMfa(false, '2026-01-01T00:00:00Z');
    const app = testApp(s);
    const code = authenticator.generate(SECRET);
    expect((await login(app, { ...creds, mfaToken: code })).status).toBe(200);
    const again = await login(app, { ...creds, mfaToken: code });
    expect([again.status, again.body.code]).toEqual([401, 'INVALID_MFA_TOKEN']);
  });

  it('UseDoubleAuth without an active secret → 409 MFA_NOT_AVAILABLE', async () => {
    const s = withMfa(false, '2026-01-01T00:00:00Z');
    s.mfaSecretMissing = true;
    const res = await login(testApp(s), { ...creds, mfaToken: authenticator.generate(SECRET) });
    expect([res.status, res.body.code]).toEqual([409, 'MFA_NOT_AVAILABLE']);
  });
});

describe('POST /auth/mfa/qr', () => {
  const qr = (app: ReturnType<typeof testApp>, b: Record<string, unknown>) =>
    request(app)
      .post('/auth/mfa/qr')
      .set('X-Api-Key', API_KEY)
      .send(b)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

  it('initial MFA + correct password → PNG, no-store', async () => {
    const res = await qr(testApp(withMfa(true)), creds);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('no-store');
    expect((res.body as Buffer).subarray(1, 4).toString()).toBe('PNG');
  });

  it('refused after verification, without MFA, or with a wrong password', async () => {
    expect(JSON.parse(String((await qr(testApp(withMfa(false, '2026-01-01T00:00:00Z')), creds)).body)).code).toBe('MFA_NOT_INITIAL');
    expect(JSON.parse(String((await qr(testApp(), creds)).body)).code).toBe('MFA_NOT_INITIAL');
    expect(JSON.parse(String((await qr(testApp(withMfa(true)), { ...creds, password: 'x' })).body)).code).toBe('INVALID_CREDENTIALS');
  });
});

describe('verifyTotp', () => {
  it('±1 step window; rejects a step at or before the last verification', () => {
    const now = Date.now();
    const code = authenticator.generate(SECRET);
    expect(verifyTotp(code, SECRET, null, now)).toBe(true);
    expect(verifyTotp(code, SECRET, new Date(now).toISOString(), now)).toBe(false);
    expect(verifyTotp(code, SECRET, new Date(now - 120_000).toISOString(), now)).toBe(true);
    expect(verifyTotp('12345', SECRET, null, now)).toBe(false);
  });
});

void ADMIN;
