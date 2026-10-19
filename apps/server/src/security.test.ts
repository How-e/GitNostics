import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from './config';
import { equalSecret, installSecurity, safeMessage } from './security';

const apps: ReturnType<typeof Fastify>[] = [];
const host = '127.0.0.1:4311';
const token = 'test-only-operator-token-not-a-credential';

async function harness(authenticated = false) {
  const app = Fastify();
  apps.push(app);
  await app.register(cookie);
  await app.register(rateLimit);
  installSecurity(
    app,
    readConfig({ NODE_ENV: 'test', AUTH_TOKEN: authenticated ? token : undefined }),
  );
  app.get('/api/private', async () => ({ private: true }));
  app.post('/api/private', async () => ({ changed: true }));
  const response = await app.inject({ url: '/api/session', headers: { host } });
  const cookieValue = String(response.headers['set-cookie']).split(';')[0]!;
  const csrf = response.json<{ csrfToken: string }>().csrfToken;
  return {
    app,
    csrf,
    cookie: cookieValue,
    headers: { host, cookie: cookieValue, 'x-csrf-token': csrf },
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('request boundary', () => {
  it('compares secrets of different lengths without throwing and redacts bounded errors', () => {
    expect(equalSecret('a', 'a')).toBe(true);
    expect(equalSecret('a', 'a much longer value')).toBe(false);
    expect(
      safeMessage(new Error('ghp_syntheticvalue123456789 Bearer synthetic-value token=synthetic')),
    ).not.toMatch(/synthetic/i);
    expect(safeMessage(new Error('x'.repeat(1000)))).toHaveLength(500);
    expect(safeMessage(undefined)).toBe('Operation failed');
  });

  it('rejects hostile Host, Origin, and cross-site requests before route handlers', async () => {
    const { app, headers } = await harness();
    expect(
      (
        await app.inject({
          url: '/api/private',
          headers: { ...headers, host: 'attacker.test:4311' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: '/api/private',
          headers: { ...headers, origin: 'https://attacker.test' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: '/api/private',
          headers: { ...headers, 'sec-fetch-site': 'cross-site' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: '/api/private',
          headers: { ...headers, 'x-forwarded-host': 'attacker.test' },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('requires a session-bound CSRF token even without an operator login', async () => {
    const { app, headers } = await harness();
    expect(
      (await app.inject({ method: 'POST', url: '/api/private', headers: { host } })).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/private',
          headers: { ...headers, 'x-csrf-token': 'wrong' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/private',
          headers: { ...headers, origin: 'null' },
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/private', headers })).statusCode).toBe(
      200,
    );
    const secondSession = await app.inject({ url: '/api/session', headers: { host } });
    const otherCookie = String(secondSession.headers['set-cookie']).split(';')[0]!;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/private',
          headers: { ...headers, cookie: otherCookie },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('protects login with CSRF, rotates CSRF on login, and invalidates logout sessions', async () => {
    const { app, headers } = await harness(true);
    expect((await app.inject({ url: '/api/private', headers })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/login',
          headers: { host },
          payload: { token },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/login',
          headers,
          payload: { token: 'wrong' },
        })
      ).statusCode,
    ).toBe(401);
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers,
      payload: { token },
    });
    expect(login.statusCode).toBe(200);
    const nextCsrf = login.json<{ csrfToken: string }>().csrfToken;
    const nextCookie = String(login.headers['set-cookie']).split(';')[0]!;
    expect(nextCsrf).not.toBe(headers['x-csrf-token']);
    expect(nextCookie).not.toBe(headers.cookie);
    expect((await app.inject({ method: 'POST', url: '/api/private', headers })).statusCode).toBe(
      401,
    );
    const signedInHeaders = { ...headers, cookie: nextCookie, 'x-csrf-token': nextCsrf };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/private',
          headers: { ...signedInHeaders, 'x-csrf-token': headers['x-csrf-token'] },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: 'POST', url: '/api/private', headers: signedInHeaders }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'POST', url: '/api/logout', headers: signedInHeaders }))
        .statusCode,
    ).toBe(200);
    expect((await app.inject({ url: '/api/private', headers: signedInHeaders })).statusCode).toBe(
      401,
    );
  });

  it('sets HTTP-only Strict cookies and prevents caching the session response', async () => {
    const { app } = await harness();
    const response = await app.inject({ url: '/api/session', headers: { host } });
    expect(response.headers['set-cookie']).toMatch(/HttpOnly/i);
    expect(response.headers['set-cookie']).toMatch(/SameSite=Strict/i);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('rate-limits operator token guesses while leaving the session endpoint available', async () => {
    const { app, headers } = await harness(true);
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/login',
            headers,
            payload: { token: 'wrong' },
          })
        ).statusCode,
      ).toBe(401);
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/login',
          headers,
          payload: { token: 'wrong' },
        })
      ).statusCode,
    ).toBe(429);
    expect((await app.inject({ url: '/api/session', headers })).statusCode).toBe(200);
  });

  it('expires an authenticated session after eight hours and issues a new unauthenticated session', async () => {
    const { app, headers } = await harness(true);
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers,
      payload: { token },
    });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const authenticatedHeaders = { ...headers, cookie };
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 8 * 60 * 60_000 + 1);
    try {
      expect(
        (await app.inject({ url: '/api/private', headers: authenticatedHeaders })).statusCode,
      ).toBe(401);
      const session = await app.inject({ url: '/api/session', headers: authenticatedHeaders });
      expect(session.json()).toMatchObject({ authenticated: false, requiresLogin: true });
      expect(String(session.headers['set-cookie']).split(';')[0]).not.toBe(cookie);
    } finally {
      clock.mockRestore();
    }
  });
});
