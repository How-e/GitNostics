import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4311),
  DATA_DIR: z.string().default('data'),
  BACKUP_INTERVAL_HOURS: z.coerce.number().int().min(0).max(168).default(24),
  AUTH_TOKEN: z.string().min(32).optional(),
  PUBLIC_ORIGIN: z.url().optional(),
  WRITE_ENABLED: z.enum(['true', 'false']).default('false'),
  ALLOW_DEVELOPMENT_PAT: z.enum(['true', 'false']).default('false'),
  GITHUB_APP_ID: z.string().regex(/^\d+$/).optional(),
  GITHUB_INSTALLATION_ID: z.string().regex(/^\d+$/).optional(),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
});
export interface Config {
  environment: 'development' | 'test' | 'production';
  host: string;
  port: number;
  dataDir: string;
  backupIntervalHours?: number;
  authToken?: string;
  publicOrigin: string;
  writesEnabled: boolean;
  github: {
    appId?: string;
    privateKey?: string;
    installationId?: number;
    token?: string;
    allowDevelopmentPat: boolean;
    allowWrites: boolean;
  };
}
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const value = envSchema.parse(
    Object.fromEntries(Object.entries(env).filter(([, v]) => v !== '')),
  );
  const local = ['127.0.0.1', 'localhost', '::1'].includes(value.HOST);
  if (!local && !value.AUTH_TOKEN)
    throw new Error('AUTH_TOKEN (at least 32 characters) is required for a non-loopback HOST.');
  if (value.WRITE_ENABLED === 'true' && !value.AUTH_TOKEN)
    throw new Error('Write functionality requires AUTH_TOKEN, including on localhost.');
  const appParts = [
    value.GITHUB_APP_ID,
    value.GITHUB_APP_PRIVATE_KEY_PATH,
    value.GITHUB_INSTALLATION_ID,
  ];
  if (appParts.some(Boolean) && !appParts.every(Boolean))
    throw new Error('Set all three GitHub App configuration variables.');
  if (
    value.GITHUB_TOKEN &&
    (value.NODE_ENV !== 'development' || value.ALLOW_DEVELOPMENT_PAT !== 'true')
  )
    throw new Error('PAT authentication requires development mode and ALLOW_DEVELOPMENT_PAT=true.');
  if (value.GITHUB_TOKEN && appParts.some(Boolean))
    throw new Error('Configure either a GitHub App or a development PAT.');
  const publicOrigin =
    value.PUBLIC_ORIGIN ?? `http://${value.HOST === '::1' ? '[::1]' : value.HOST}:${value.PORT}`;
  const origin = new URL(publicOrigin);
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new Error('PUBLIC_ORIGIN must be an HTTP(S) origin without a path or credentials.');
  if (
    !local &&
    value.NODE_ENV === 'production' &&
    origin.protocol !== 'https:' &&
    !['127.0.0.1', 'localhost'].includes(origin.hostname)
  )
    throw new Error(
      'Remote production access requires an HTTPS PUBLIC_ORIGIN behind a trusted TLS reverse proxy.',
    );
  return {
    environment: value.NODE_ENV,
    host: value.HOST,
    port: value.PORT,
    dataDir: resolve(value.DATA_DIR),
    authToken: value.AUTH_TOKEN,
    publicOrigin: origin.origin,
    backupIntervalHours: value.BACKUP_INTERVAL_HOURS,
    writesEnabled: value.WRITE_ENABLED === 'true',
    github: {
      appId: value.GITHUB_APP_ID,
      privateKey: value.GITHUB_APP_PRIVATE_KEY_PATH
        ? readFileSync(resolve(value.GITHUB_APP_PRIVATE_KEY_PATH), 'utf8')
        : undefined,
      installationId: value.GITHUB_INSTALLATION_ID
        ? Number(value.GITHUB_INSTALLATION_ID)
        : undefined,
      token: value.GITHUB_TOKEN,
      allowDevelopmentPat: value.ALLOW_DEVELOPMENT_PAT === 'true',
      allowWrites: value.WRITE_ENABLED === 'true',
    },
  };
}
