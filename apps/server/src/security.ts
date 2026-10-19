import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from './config';
import { redactLog } from '@gitnostics/github';

interface Session {
  csrfToken: string;
  authenticated: boolean;
  expires: number;
}
export function equalSecret(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}
export function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Operation failed';
  return redactLog(message.slice(0, 16_384)).slice(0, 500);
}
export function apiRoutePath(request: FastifyRequest): string | undefined {
  // Fastify matches encoded static segments to their canonical registered route.
  // Use that same identity so URL aliases cannot escape API security boundaries.
  const route = request.routeOptions.url;
  if (route?.startsWith('/api/')) return route;
  const path = request.url.split('?')[0];
  return path?.startsWith('/api/') ? path : undefined;
}
export function installSecurity(app: FastifyInstance, config: Config) {
  const sessions = new Map<string, Session>();
  const origin = new URL(config.publicOrigin);
  const origins = new Set([origin.origin]);
  const hosts = new Set([origin.host]);
  if (['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      hosts.add(`${host}:${config.port}`);
      origins.add(`http://${host}:${config.port}`);
      if (config.environment === 'development') {
        hosts.add(`${host}:4310`);
        origins.add(`http://${host}:4310`);
      }
    }
  }
  // The direct container health check is loopback; never trusts forwarded host headers.
  hosts.add(`127.0.0.1:${config.port}`);
  function current(request: FastifyRequest): Session | undefined {
    const key = request.cookies.gn_session;
    const session = key ? sessions.get(key) : undefined;
    if (session && session.expires > Date.now()) return session;
    if (key) sessions.delete(key);
    return undefined;
  }
  app.addHook('onRequest', async (request, reply) => {
    if (!hosts.has(request.headers.host ?? ''))
      return reply.code(403).send({ error: 'Unrecognized Host header.' });
    const requestOrigin = request.headers.origin;
    if (requestOrigin && !origins.has(requestOrigin))
      return reply.code(403).send({ error: 'Origin is not permitted.' });
    if (request.headers['sec-fetch-site'] === 'cross-site')
      return reply.code(403).send({ error: 'Cross-site requests are not permitted.' });
    const path = apiRoutePath(request);
    if (!path) return;
    const publicRoute = ['/api/health', '/api/session', '/api/login'].includes(path);
    if (!publicRoute && config.authToken && !current(request)?.authenticated)
      return reply.code(401).send({ error: 'Operator sign-in required.' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const session = current(request);
      const csrf = request.headers['x-csrf-token'];
      if (!session || typeof csrf !== 'string' || !equalSecret(csrf, session.csrfToken))
        return reply.code(403).send({ error: 'Invalid CSRF token. Reload and try again.' });
      if (requestOrigin === 'null')
        return reply.code(403).send({ error: 'Invalid request origin.' });
    }
  });
  app.get(
    '/api/session',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      let session = current(request);
      if (!session) {
        for (const [key, value] of sessions) if (value.expires <= Date.now()) sessions.delete(key);
        if (sessions.size >= 1000)
          return reply.code(503).send({ error: 'Too many sessions. Try again later.' });
        const id = randomBytes(32).toString('hex');
        session = {
          csrfToken: randomBytes(32).toString('hex'),
          authenticated: !config.authToken,
          expires: Date.now() + (config.authToken ? 10 * 60 : 8 * 60 * 60) * 1000,
        };
        sessions.set(id, session);
        reply.setCookie('gn_session', id, {
          httpOnly: true,
          sameSite: 'strict',
          secure: origin.protocol === 'https:',
          path: '/',
          maxAge: 8 * 60 * 60,
        });
      }
      reply.header('Cache-Control', 'no-store');
      return {
        csrfToken: session.csrfToken,
        authenticated: session.authenticated,
        requiresLogin: !!config.authToken,
      };
    },
  );
  app.post(
    '/api/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = request.body as { token?: unknown } | undefined;
      if (
        !config.authToken ||
        typeof body?.token !== 'string' ||
        !equalSecret(body.token, config.authToken)
      )
        return reply.code(401).send({ error: 'Invalid operator token.' });
      const session = current(request)!;
      const previousId = request.cookies.gn_session;
      if (previousId) sessions.delete(previousId);
      const nextId = randomBytes(32).toString('hex');
      session.authenticated = true;
      session.expires = Date.now() + 8 * 60 * 60 * 1000;
      session.csrfToken = randomBytes(32).toString('hex');
      sessions.set(nextId, session);
      reply.setCookie('gn_session', nextId, {
        httpOnly: true,
        sameSite: 'strict',
        secure: origin.protocol === 'https:',
        path: '/',
        maxAge: 8 * 60 * 60,
      });
      return { csrfToken: session.csrfToken, authenticated: true };
    },
  );
  app.post('/api/logout', async (request, reply) => {
    const id = request.cookies.gn_session;
    if (id) sessions.delete(id);
    reply.clearCookie('gn_session', { path: '/' });
    return { ok: true };
  });
}
