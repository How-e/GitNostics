import { describe, expect, it } from 'vitest';
import { demoSnapshots } from '../../../apps/server/src/demo.js';
import { redactStoredText, Store } from '../../../apps/server/src/db/index.js';
import { logExcerpt, redactLog as redactGitHubLog } from '../../github/src/logs.js';
import { classifyFailure, redactLog } from '../src/index.js';

const session = 'synthetic-cookie-session-value';
const secondary = 'synthetic-cookie-secondary-value';
const cases = [
  ['request header', `Cookie: sid=${session}; preference=${secondary}`],
  ['response header', `Set-Cookie: sid=${session}; refresh=${secondary}; Path=/; HttpOnly`],
  ['mixed case', `sEt-CoOkIe: sid=${session}; refresh=${secondary}`],
  ['quoted first cookie', `Cookie: "${session}"; other=${secondary}`],
  ['timestamp prefix', `2026-10-19T12:00:00.000Z < Cookie: sid=${session}; pref=${secondary}`],
  ['curl double quotes', `curl -H "Cookie: sid=${session}; pref=${secondary}" --fail`],
  ['curl single quotes', `curl -H 'Set-Cookie: sid=${session}; pref=${secondary}' --fail`],
  ['JSON header', JSON.stringify({ Cookie: `sid=${session}; pref=${secondary}`, safe: 'kept' })],
  ['JSON response header', JSON.stringify({ 'set-cookie': `sid=${session}; pref=${secondary}` })],
  ['JSON cookie array', JSON.stringify({ 'set-cookie': [`sid=${session}`, `pref=${secondary}`] })],
  ['single-quoted object', `{'Cookie': 'sid=${session}; pref=${secondary}', 'safe': 'kept'}`],
  ['escaped JSON value', String.raw`{"Cookie":"sid=${session}\"${secondary}","safe":"kept"}`],
  ['truncated quoted header', `"Cookie: sid=${session}; pref=${secondary}`],
  ['truncated quoted value', `{"Set-Cookie":"sid=${session}; pref=${secondary}`],
] as const;

describe.each([
  { name: 'GitHub logs', redact: redactGitHubLog },
  { name: 'diagnostic evidence', redact: redactLog },
  { name: 'stored text', redact: redactStoredText },
])('$name cookie redaction', ({ redact }) => {
  it.each(cases)('removes every credential in a %s', (_name, source) => {
    const result = redact(source);
    expect(result).not.toContain(session);
    expect(result).not.toContain(secondary);
    expect(result).toContain('[REDACTED COOKIE]');
    expect(redact(result)).toBe(result);
  });

  it('preserves adjacent quoted context and unrelated cookie terminology', () => {
    const source = [
      `curl -H "Cookie: sid=${session}" --fail https://example.test`,
      JSON.stringify({ headers: { Cookie: `sid=${session}` }, safe: 'kept' }),
      'cookiePolicy=keep; cookie_name=keep',
      'Cookie:',
      'Error: assertion failed',
    ].join('\n');
    const result = redact(source);
    expect(result).toContain('--fail https://example.test');
    expect(JSON.parse(result.split('\n')[1]!)).toEqual({
      headers: { Cookie: '[REDACTED COOKIE]' },
      safe: 'kept',
    });
    expect(result).toContain('cookiePolicy=keep; cookie_name=keep');
    expect(result).toContain('Error: assertion failed');
  });
});

it('removes cookies before selecting log tails and deriving failure signatures', () => {
  const source = `Error: request failed; Cookie: sid=${session}; other=${secondary}`;
  const fetched = logExcerpt(source);
  const signature = classifyFailure(fetched);
  const directSignature = classifyFailure(source);
  for (const output of [
    fetched,
    signature.excerpt,
    signature.signature,
    directSignature.signature,
  ]) {
    expect(output).not.toContain(session);
    expect(output).not.toContain(secondary);
  }
  expect(classifyFailure(source.replaceAll(session, 'different-cookie-value')).fingerprint).toBe(
    directSignature.fingerprint,
  );
});

it('redacts raw cookie headers when persisting a snapshot without upstream redaction', () => {
  const store = new Store(':memory:');
  try {
    const snapshot = demoSnapshots(new Date('2026-10-19T12:00:00Z'))[0]!;
    const source = `Error: request failed\nCookie: sid=${session}; other=${secondary}`;
    snapshot.runs[0]!.jobs = [
      { id: 1, name: 'test', conclusion: 'failure', url: '', logExcerpt: source },
    ];
    snapshot.warnings = [source];
    store.saveSnapshot('live', snapshot);
    const persisted = store.repositories('live')[0]!.snapshot!;
    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toContain(session);
    expect(serialized).not.toContain(secondary);
    expect(persisted.runs[0]!.jobs[0]!.logExcerpt).toContain('[REDACTED COOKIE]');
    expect(persisted.warnings[0]).toContain('[REDACTED COOKIE]');
  } finally {
    store.close();
  }
});
