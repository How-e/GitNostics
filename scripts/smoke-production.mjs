import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const prefix = resolve(tmpdir(), 'gitnostics-production-');
const dataDir = await mkdtemp(prefix);
assert.ok(resolve(dataDir).startsWith(prefix), 'Unexpected smoke-test data directory');
const reservation = createServer();
await new Promise((done) => reservation.listen(0, '127.0.0.1', done));
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const origin = `http://127.0.0.1:${port}`;
let child;
let output = '';
const env = {
  ...process.env,
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  PORT: String(port),
  DATA_DIR: dataDir,
  PUBLIC_ORIGIN: origin,
  AUTH_TOKEN: '',
  WRITE_ENABLED: 'false',
  BACKUP_INTERVAL_HOURS: '0',
  GITHUB_APP_ID: '',
  GITHUB_INSTALLATION_ID: '',
  GITHUB_APP_PRIVATE_KEY_PATH: '',
  GITHUB_TOKEN: '',
  ALLOW_DEVELOPMENT_PAT: 'false',
};
async function start() {
  child = spawn(process.execPath, ['dist/server.js'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (data) => {
    output = (output + data).slice(-8000);
  });
  child.stderr.on('data', (data) => {
    output = (output + data).slice(-8000);
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Production server exited: ${output}`);
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      /* Wait for the owned child to listen. */
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Production server did not become healthy: ${output}`);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((done) => child.once('exit', done));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await exited;
  clearTimeout(timer);
}
async function session() {
  const response = await fetch(`${origin}/api/session`);
  assert.equal(response.status, 200);
  return {
    cookie: response.headers.get('set-cookie').split(';')[0],
    csrf: (await response.json()).csrfToken,
  };
}
async function request(path, credentials, method = 'GET', body) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      cookie: credentials.cookie,
      'x-csrf-token': credentials.csrf,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}
try {
  await start();
  for (const path of ['/', '/repositories/northstar/api']) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<title>GitNostics/);
  }
  const credentials = await session();
  await request('/api/demo/reset', credentials, 'POST', {});
  const dashboard = await request('/api/dashboard?mode=demo', credentials);
  assert.equal(dashboard.repositories.length, 3);
  assert.ok(dashboard.findings.length > 0);
  assert.ok(dashboard.workflowAnalytics.length > 0);
  await request('/api/settings?mode=demo', credentials, 'PUT', {
    ...dashboard.settings,
    retentionDays: 45,
  });
  const backedUp = await request('/api/dashboard?mode=demo', credentials);
  const backup = await request('/api/backup', credentials, 'POST', {});
  assert.ok((await readdir(join(dataDir, 'backups'))).includes(backup.filename));
  await stop();
  await start();
  const nextCredentials = await session();
  const restored = await request('/api/dashboard?mode=demo', nextCredentials);
  assert.equal(restored.repositories.length, 3);
  assert.equal(restored.settings.retentionDays, 45);
  assert.deepEqual(
    restored.findings.map((f) => f.id).sort(),
    dashboard.findings.map((f) => f.id).sort(),
  );
  assert.equal((await request('/api/dashboard?mode=live', nextCredentials)).repositories.length, 0);
  // Prove recovery from the backup, rather than merely reopening the active database.
  // A post-backup change must disappear after restoring the earlier snapshot.
  await request('/api/settings?mode=demo', nextCredentials, 'PUT', {
    ...restored.settings,
    retentionDays: 60,
  });
  assert.equal(
    (await request('/api/dashboard?mode=demo', nextCredentials)).settings.retentionDays,
    60,
  );
  await stop();
  const recoveryDirectory = join(dataDir, 'recovery');
  await mkdir(recoveryDirectory);
  for (const filename of await readdir(dataDir)) {
    if (['gitnostics.sqlite', 'gitnostics.sqlite-wal', 'gitnostics.sqlite-shm'].includes(filename))
      await rename(join(dataDir, filename), join(recoveryDirectory, filename));
  }
  await copyFile(join(dataDir, 'backups', backup.filename), join(dataDir, 'gitnostics.sqlite'));
  const restoredDatabase = new DatabaseSync(join(dataDir, 'gitnostics.sqlite'), { readOnly: true });
  try {
    assert.equal(restoredDatabase.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(restoredDatabase.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    restoredDatabase.close();
  }
  await start();
  const recoveryCredentials = await session();
  const recovered = await request('/api/dashboard?mode=demo', recoveryCredentials);
  assert.deepEqual(recovered.repositories, backedUp.repositories);
  assert.deepEqual(recovered.findings, backedUp.findings);
  assert.equal(recovered.settings.retentionDays, 45);
  assert.equal(
    (await request('/api/dashboard?mode=live', recoveryCredentials)).repositories.length,
    0,
  );
  console.log(
    JSON.stringify({
      node: process.version,
      production: 'pass',
      staticRoutes: 'pass',
      restartPersistence: 'pass',
      backup: 'pass',
      stoppedServiceRestore: 'pass',
      sqliteIntegrity: 'pass',
      modeIsolation: 'pass',
      githubRequests: 0,
    }),
  );
} finally {
  await stop();
  await rm(dataDir, { recursive: true, force: true });
}
