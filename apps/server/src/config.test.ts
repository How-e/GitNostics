import { describe, expect, it } from 'vitest';
import { readConfig } from './config';

const operatorToken = 'test-only-operator-token-not-a-credential';

describe('deployment configuration', () => {
  it('defaults to a local, read-only deployment with no GitHub credentials', () => {
    expect(readConfig({})).toMatchObject({
      environment: 'production',
      host: '127.0.0.1',
      port: 4311,
      publicOrigin: 'http://127.0.0.1:4311',
      writesEnabled: false,
      github: { allowWrites: false, allowDevelopmentPat: false },
    });
  });

  it('requires operator authentication for remote listeners and all write opt-ins', () => {
    expect(() => readConfig({ HOST: '0.0.0.0' })).toThrow(/AUTH_TOKEN/);
    expect(() => readConfig({ WRITE_ENABLED: 'true' })).toThrow(/AUTH_TOKEN/);
    expect(() => readConfig({ AUTH_TOKEN: 'short' })).toThrow();
    expect(readConfig({ WRITE_ENABLED: 'true', AUTH_TOKEN: operatorToken }).writesEnabled).toBe(
      true,
    );
  });

  it('requires HTTPS for remote production access', () => {
    expect(() =>
      readConfig({
        NODE_ENV: 'production',
        HOST: '0.0.0.0',
        AUTH_TOKEN: operatorToken,
        PUBLIC_ORIGIN: 'http://example.test',
      }),
    ).toThrow(/HTTPS/);
    expect(
      readConfig({
        NODE_ENV: 'production',
        HOST: '0.0.0.0',
        AUTH_TOKEN: operatorToken,
        PUBLIC_ORIGIN: 'https://example.test',
      }).publicOrigin,
    ).toBe('https://example.test');
  });

  it.each([
    'https://example.test/path',
    'https://operator:password@example.test',
    'https://example.test/?query=1',
    'https://example.test/#fragment',
    'file:///tmp/local',
  ])('rejects an invalid public origin %s', (publicOrigin) => {
    expect(() => readConfig({ PUBLIC_ORIGIN: publicOrigin })).toThrow();
  });

  it('brackets IPv6 loopback and treats empty optional environment values as unset', () => {
    expect(readConfig({ HOST: '::1', AUTH_TOKEN: '', GITHUB_TOKEN: '' }).publicOrigin).toBe(
      'http://[::1]:4311',
    );
  });

  it('requires complete App configuration and explicitly enabled development PATs', () => {
    expect(() => readConfig({ GITHUB_APP_ID: '1' })).toThrow(/all three/);
    expect(() => readConfig({ GITHUB_TOKEN: 'synthetic-test-value' })).toThrow(
      /PAT authentication/,
    );
    expect(() =>
      readConfig({
        NODE_ENV: 'production',
        GITHUB_TOKEN: 'synthetic-test-value',
        ALLOW_DEVELOPMENT_PAT: 'true',
      }),
    ).toThrow(/PAT authentication/);
    expect(
      readConfig({
        NODE_ENV: 'development',
        GITHUB_TOKEN: 'synthetic-test-value',
        ALLOW_DEVELOPMENT_PAT: 'true',
      }).github.allowDevelopmentPat,
    ).toBe(true);
  });

  it('rejects malformed ports, booleans, and App IDs before startup', () => {
    expect(() => readConfig({ PORT: '0' })).toThrow();
    expect(() => readConfig({ WRITE_ENABLED: 'yes' })).toThrow();
    expect(() => readConfig({ GITHUB_APP_ID: 'not-an-id' })).toThrow();
    expect(() => readConfig({ BACKUP_INTERVAL_HOURS: '169' })).toThrow();
    expect(readConfig({ BACKUP_INTERVAL_HOURS: '0' }).backupIntervalHours).toBe(0);
  });
});
