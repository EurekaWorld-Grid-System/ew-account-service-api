import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';

describe('ew-account-service-api', () => {
  it('GET /health returns ok with service and version', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', service: 'ew-account-service-api' });
    expect(typeof res.body.version).toBe('string');
  });

  it('unknown routes return 404 NOT_FOUND', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('a malformed JSON body returns 400 INVALID_JSON', async () => {
    const res = await request(app).post('/anything').set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_JSON');
  });
});
