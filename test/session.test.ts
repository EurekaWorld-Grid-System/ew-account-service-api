import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { readCookie } from '../src/routes/auth';
import { API_KEY, fakeState, FakeState, keys, testApp, USER } from './fakes';

const creds = { username: 'jdoe', password: 'OldPassw0rd1' };

const cookieOf = (res: request.Response): string | undefined => {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const c = (raw ?? []).find(x => x.startsWith('ewRefreshToken='));
  return c ? decodeURIComponent(c.split(';')[0].slice('ewRefreshToken='.length)) : undefined;
};

async function loggedIn(s: FakeState = fakeState()) {
  const app = testApp(s);
  const res = await request(app).post('/auth/login').set('X-Api-Key', API_KEY).set('X-Client-IP', '203.0.113.7').send(creds);
  expect(res.status).toBe(200);
  const access: string = res.body.accessToken;
  const sid = (jwt.decode(access) as { sid: string }).sid;
  return { app, s, access, refresh: cookieOf(res)!, sid };
}

const post = (app: ReturnType<typeof testApp>, path: string) => request(app).post(path).set('X-Api-Key', API_KEY);
const doRefresh = (app: ReturnType<typeof testApp>, token?: string) => {
  const r = post(app, '/auth/refresh');
  return token ? r.set('Cookie', `other=1; ewRefreshToken=${encodeURIComponent(token)}`) : r;
};

describe('login creates a session', () => {
  it('stores user, jti and IP; access and refresh tokens carry its id', async () => {
    const { s, access, refresh, sid } = await loggedIn();
    const session = s.sessions.get(sid)!;
    expect(session).toMatchObject({ userId: USER, clientIp: '203.0.113.7', revokedReason: null });
    expect(jwt.decode(refresh)).toMatchObject({ sub: USER, type: 'refresh', sid, jti: session.refreshJti });
    expect(jwt.decode(access)).toMatchObject({ sub: USER, sid });
  });
});

describe('POST /auth/refresh (copied from ew-portal-api, with rotation)', () => {
  it('needs the caller X-Api-Key', async () => {
    const res = await request(testApp()).post('/auth/refresh');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_API_KEY');
  });

  it('no cookie → 401 TOKEN_INVALID', async () => {
    const res = await doRefresh(testApp());
    expect([res.status, res.body.code, res.body.message]).toEqual([401, 'TOKEN_INVALID', 'No refresh token']);
  });

  it('valid → new access token (same claims as login) + rotated refresh cookie', async () => {
    const { app, s, refresh, sid } = await loggedIn();
    const res = await doRefresh(app, refresh);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const claims = jwt.verify(res.body.accessToken, keys.publicKey) as Record<string, unknown>;
    expect(claims).toMatchObject({
      sub: USER, accountId: 'acc-9', username: 'jdoe', globalRole: 'user', organization: 'general', instituteId: 'inst-1', isInitial: false, sid,
    });
    const next = cookieOf(res)!;
    const decoded = jwt.decode(next) as Record<string, unknown>;
    expect(decoded).toMatchObject({ sub: USER, type: 'refresh', sid });
    expect(decoded.jti).toBe(s.sessions.get(sid)!.refreshJti);
    expect(decoded.jti).not.toBe((jwt.decode(refresh) as Record<string, unknown>).jti);
    expect((await doRefresh(app, next)).status).toBe(200);
  });

  it('the previous token within the grace window (another tab) → current jti, session stays', async () => {
    const { app, s, refresh, sid } = await loggedIn();
    const first = cookieOf(await doRefresh(app, refresh))!;
    const second = await doRefresh(app, refresh);
    expect(second.status).toBe(200);
    expect((jwt.decode(cookieOf(second)!) as Record<string, unknown>).jti).toBe((jwt.decode(first) as Record<string, unknown>).jti);
    expect(s.sessions.get(sid)!.revokedReason).toBeNull();
  });

  it('an older token after the grace window → session revoked (reuse), cookie cleared', async () => {
    const { app, s, refresh, sid } = await loggedIn();
    const next = cookieOf(await doRefresh(app, refresh))!;
    s.sessions.get(sid)!.rotatedAt = Date.now() - 61_000;
    const res = await doRefresh(app, refresh);
    expect([res.status, res.body.code, res.body.message]).toEqual([401, 'TOKEN_INVALID', 'Session revoked']);
    expect(String(res.headers['set-cookie'])).toMatch(/ewRefreshToken=;.*Expires=Thu, 01 Jan 1970/);
    expect(s.sessions.get(sid)!.revokedReason).toBe('reuse');
    // the legitimate holder is logged out too
    expect((await doRefresh(app, next)).body.message).toBe('Session revoked');
  });

  it('an access token, a foreign signature or a token without session → 401', async () => {
    const { app, access } = await loggedIn();
    expect((await doRefresh(app, access)).body).toEqual({ code: 'TOKEN_INVALID', message: 'Invalid token type' });
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const forged = jwt.sign({ sub: USER, type: 'refresh', sid: 'x', jti: 'y' }, other, { algorithm: 'RS256' });
    expect((await doRefresh(app, forged)).body.message).toBe('Invalid refresh token');
    const legacy = jwt.sign({ sub: USER, type: 'refresh' }, keys.privateKey, { algorithm: 'RS256', expiresIn: '1h' });
    const res = await doRefresh(app, legacy);
    expect([res.status, res.body.message]).toEqual([401, 'Session not found']);
  });

  it('expired → 401 TOKEN_EXPIRED; expired session → 401 TOKEN_EXPIRED', async () => {
    const { app, s, sid } = await loggedIn();
    const old = jwt.sign({ sub: USER, type: 'refresh', sid, exp: Math.floor(Date.now() / 1000) - 10 }, keys.privateKey, { algorithm: 'RS256', jwtid: 'j' });
    expect((await doRefresh(app, old)).body).toEqual({ code: 'TOKEN_EXPIRED', message: 'Refresh token expired' });
    const x = s.sessions.get(sid)!;
    x.expiresAt = Date.now() - 1;
    const fresh = jwt.sign({ sub: USER, type: 'refresh', sid }, keys.privateKey, { algorithm: 'RS256', jwtid: x.refreshJti, expiresIn: '1h' });
    expect((await doRefresh(app, fresh)).body).toEqual({ code: 'TOKEN_EXPIRED', message: 'Session expired' });
  });

  it('user no longer in the index → 401 User not found, session revoked', async () => {
    const { app, s, refresh, sid } = await loggedIn();
    s.users.delete(USER);
    const res = await doRefresh(app, refresh);
    expect([res.status, res.body.message]).toEqual([401, 'User not found']);
    expect(s.sessions.get(sid)!.revokedReason).toBe('user-not-found');
  });
});

describe('POST /auth/verify', () => {
  const verify = (app: ReturnType<typeof testApp>, auth?: string) => {
    const r = post(app, '/auth/verify');
    return auth ? r.set('Authorization', auth) : r;
  };

  it('active session → 200 { claims }', async () => {
    const { app, access, sid } = await loggedIn();
    const res = await verify(app, `Bearer ${access}`);
    expect(res.status).toBe(200);
    expect(res.body.claims).toMatchObject({ sub: USER, accountId: 'acc-9', username: 'jdoe', globalRole: 'user', sid });
    expect(typeof res.body.claims.exp).toBe('number');
  });

  it('same 401 codes as requireAuth; revoked or missing session → TOKEN_INVALID', async () => {
    const { app, s, access, refresh, sid } = await loggedIn();
    expect((await verify(app)).body).toEqual({ code: 'TOKEN_INVALID', message: 'Missing or invalid Authorization header' });
    expect((await verify(app, 'Bearer nope')).body).toEqual({ code: 'TOKEN_INVALID', message: 'Invalid token' });
    expect((await verify(app, `Bearer ${refresh}`)).body.message).toBe('Invalid token'); // refresh token as access token
    const expired = jwt.sign({ sub: USER, sid, exp: Math.floor(Date.now() / 1000) - 5 }, keys.privateKey, { algorithm: 'RS256' });
    expect((await verify(app, `Bearer ${expired}`)).body).toEqual({ code: 'TOKEN_EXPIRED', message: 'Access token expired' });
    const legacy = jwt.sign({ sub: USER }, keys.privateKey, { algorithm: 'RS256', expiresIn: '5m' });
    expect((await verify(app, `Bearer ${legacy}`)).body.message).toBe('Session not found');
    s.sessions.get(sid)!.revokedReason = 'test';
    const res = await verify(app, `Bearer ${access}`);
    expect([res.status, res.body.code, res.body.message]).toEqual([401, 'TOKEN_INVALID', 'Session revoked']);
  });
});

describe('POST /auth/logout', () => {
  it('needs a valid access token (as requireAuth)', async () => {
    const res = await post(testApp(), '/auth/logout');
    expect([res.status, res.body.code]).toEqual([401, 'TOKEN_INVALID']);
  });

  it('revokes the session and clears the cookie; refresh and verify then fail', async () => {
    const { app, s, access, refresh, sid } = await loggedIn();
    const res = await post(app, '/auth/logout').set('Authorization', `Bearer ${access}`);
    expect([res.status, res.body.message]).toEqual([200, 'Logged out']);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/ewRefreshToken=;/);
    expect(cookie).toMatch(/Domain=\.example\.test/);
    expect(s.sessions.get(sid)!.revokedReason).toBe('logout');
    expect((await doRefresh(app, refresh)).body.message).toBe('Session revoked');
    expect((await post(app, '/auth/verify').set('Authorization', `Bearer ${access}`)).body.message).toBe('Session revoked');
  });
});

describe('GET /auth/.well-known/jwks.json', () => {
  it('the public key, with the same kid as ew-portal-api', async () => {
    const res = await request(testApp()).get('/auth/.well-known/jwks.json').set('X-Api-Key', API_KEY);
    expect(res.status).toBe(200);
    const jwk = crypto.createPublicKey(keys.publicKey).export({ format: 'jwk' });
    const kid = crypto.createHash('sha256').update(JSON.stringify(jwk)).digest('base64url');
    expect(res.body).toEqual({ keys: [{ ...jwk, use: 'sig', alg: 'RS256', kid }] });
    expect(res.body.keys[0].d).toBeUndefined();
  });
});

describe('readCookie', () => {
  it('finds one cookie among several', () => {
    expect(readCookie('a=1; ewRefreshToken=x%2By; b=2', 'ewRefreshToken')).toBe('x+y');
    expect(readCookie('a=1', 'ewRefreshToken')).toBeUndefined();
    expect(readCookie(undefined, 'ewRefreshToken')).toBeUndefined();
  });
});
