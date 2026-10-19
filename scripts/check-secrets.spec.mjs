import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scanner = fileURLToPath(new URL('./check-secrets.mjs', import.meta.url));
const ignore = fileURLToPath(new URL('../.gitignore', import.meta.url));
const fakeToken = ['gh', 'p_', 'A'.repeat(36)].join('');

function fixture(run) {
  const cwd = mkdtempSync(join(tmpdir(), 'gitnostics-privacy-'));
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  const scan = () => spawnSync(process.execPath, [scanner], { cwd, encoding: 'utf8' });
  try {
    git('init', '--quiet');
    git('config', 'user.name', 'Privacy fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    copyFileSync(ignore, join(cwd, '.gitignore'));
    run({ cwd, git, scan });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('private and generated paths stay ignored while publication inputs remain visible', () => {
  fixture(({ cwd, git, scan }) => {
    for (const path of [
      '.env',
      '.env.production',
      'data/local.db',
      'screenshots/private.png',
      'local-reports/output.txt',
      'backups/copy.zip',
      'key.pfx',
      '.npmrc',
      'compose.override.yml',
      'apps/web/dist/index.html',
      '.local/evidence.txt',
    ]) {
      assert.equal(
        spawnSync('git', ['check-ignore', '--quiet', '--', path], { cwd }).status,
        0,
        path,
      );
    }
    writeFileSync(join(cwd, '.env'), fakeToken);
    writeFileSync(join(cwd, '.env.example'), 'AUTH_TOKEN=\n');
    for (const path of [
      '.env.example',
      'pnpm-lock.yaml',
      'apps/server/src/db/migrations.ts',
      'apps/web/public/favicon.svg',
    ]) {
      assert.equal(
        spawnSync('git', ['check-ignore', '--quiet', '--', path], { cwd }).status,
        1,
        path,
      );
    }
    git('add', '.');
    assert.equal(scan().status, 0);
  });
});

test('rejects a force-added credential file without printing its contents', () => {
  fixture(({ cwd, git, scan }) => {
    writeFileSync(join(cwd, '.env'), fakeToken);
    git('add', '--force', '.env');
    const result = scan();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Private\/generated file/u);
    assert.ok(!result.stderr.includes(fakeToken));
  });
});

test('inspects the staged version independently of sanitized working content', () => {
  fixture(({ cwd, git, scan }) => {
    writeFileSync(join(cwd, 'notes.txt'), fakeToken);
    git('add', 'notes.txt');
    writeFileSync(join(cwd, 'notes.txt'), 'sanitized');
    const result = scan();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /index: notes.txt/u);
    assert.ok(!result.stderr.includes(fakeToken));
  });
});

test('detects secrets deleted from the current tree but retained in history', () => {
  fixture(({ cwd, git, scan }) => {
    writeFileSync(join(cwd, 'notes.txt'), fakeToken);
    git('add', '.');
    git('commit', '--quiet', '-m', 'Synthetic fixture');
    git('rm', '--quiet', 'notes.txt');
    git('commit', '--quiet', '-m', 'Remove synthetic fixture');
    const result = scan();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /history [a-f0-9]+: notes.txt/u);
    assert.ok(!result.stderr.includes(fakeToken));
  });
});

test('rejects binary files rather than silently skipping their content', () => {
  fixture(({ cwd, scan }) => {
    writeFileSync(join(cwd, 'unknown.bin'), Buffer.from([0, 1, 2]));
    const result = scan();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot inspect binary file/u);
  });
});
