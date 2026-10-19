import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ActionPreview,
  ConnectionStatus,
  Dashboard,
  RepositorySnapshot,
} from '@gitnostics/shared';
import { defaultSettings } from '@gitnostics/shared';
import { createApp, type GitHubService } from './app';
import { readConfig } from './config';
import { demoSnapshots } from './demo';
import { Store } from './db';

const host = '127.0.0.1:4311';
const token = 'test-only-operator-token-not-a-credential';
const cleanups: (() => Promise<void>)[] = [];
const snapshot = (): RepositorySnapshot => structuredClone(demoSnapshots()[0]!);

async function harness(options: { writes?: boolean; auth?: boolean; permission?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'gitnostics-api-test-'));
  const connection: ConnectionStatus = {
    mode: 'app',
    connected: true,
    identity: 'Synthetic installation',
    writesEnabled: options.permission ?? true,
  };
  const github: GitHubService = {
    snapshot: vi.fn(async () => snapshot()),
    getConnectionStatus: () => ({ ...connection }),
    discoverRepositories: vi.fn(async () => [{ fullName: 'northstar/api', private: true }]),
    execute: vi.fn(async () => undefined),
    disconnect: vi.fn(() => {
      connection.connected = false;
      connection.writesEnabled = false;
    }),
  };
  const config = readConfig({
    NODE_ENV: 'test',
    DATA_DIR: directory,
    WRITE_ENABLED: options.writes ? 'true' : 'false',
    AUTH_TOKEN: options.auth || options.writes ? token : undefined,
  });
  const instance = await createApp({ config, github, background: false });
  cleanups.push(async () => {
    await instance.app.close();
    if (!resolve(directory).startsWith(resolve(tmpdir(), 'gitnostics-api-test-')))
      throw new Error('Unexpected test cleanup directory');
    rmSync(directory, { recursive: true, force: true });
  });
  const response = await instance.app.inject({ url: '/api/session', headers: { host } });
  let cookie = String(response.headers['set-cookie']).split(';')[0]!;
  let csrf = response.json<{ csrfToken: string }>().csrfToken;
  if (options.auth || options.writes) {
    const login = await instance.app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { host, cookie, 'x-csrf-token': csrf },
      payload: { token },
    });
    expect(login.statusCode).toBe(200);
    cookie = String(login.headers['set-cookie']).split(';')[0]!;
    csrf = login.json<{ csrfToken: string }>().csrfToken;
  }
  const headers = { host, cookie, 'x-csrf-token': csrf, origin: 'http://127.0.0.1:4311' };
  const get = (url: string) => instance.app.inject({ url, headers });
  const post = (url: string, payload: unknown = {}) =>
    instance.app.inject({
      method: 'POST',
      url,
      headers,
      payload: payload as Record<string, unknown>,
    });
  return { ...instance, config, directory, github, connection, headers, get, post };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

describe('HTTP workspace API with a synthetic GitHub service', () => {
  it('returns a healthy empty live dashboard and refuses malformed mode/input', async () => {
    const { get, post, github } = await harness();
    expect((await get('/api/health')).json()).toMatchObject({ status: 'ok', database: 'ready' });
    const response = await get('/api/dashboard');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json<Dashboard>().repositories).toEqual([]);
    expect((await get('/api/dashboard?mode=invalid')).statusCode).toBe(400);
    expect((await post('/api/repositories', { fullName: '../../secret' })).statusCode).toBe(400);
    expect(
      (await post('/api/repositories?mode=demo', { fullName: 'northstar/api' })).statusCode,
    ).toBe(400);
    expect(github.snapshot).not.toHaveBeenCalled();
    expect(github.execute).not.toHaveBeenCalled();
  });

  it('isolates demo reset, findings, notifications, baselines, settings, and actions from live data', async () => {
    const { app, store, get, post, github, headers } = await harness();
    store.saveSnapshot('live', snapshot());
    store.saveSettings('live', { ...defaultSettings, theme: 'light' });
    store.audit('live', 'synthetic.fixture', 'Live metadata must survive demo reset.');
    expect((await post('/api/demo/reset')).statusCode).toBe(200);
    const demo = (await get('/api/dashboard?mode=demo')).json<Dashboard>();
    expect(demo.repositories).toHaveLength(3);
    expect(demo.findings.length).toBeGreaterThan(0);
    expect(demo.notifications.length).toBeGreaterThan(0);
    expect(demo.connection.identity).toContain('Fictional');
    const finding = demo.findings[0]!;
    expect(
      (await post(`/api/notifications/${demo.notifications[0]!.id}/read?mode=demo`)).statusCode,
    ).toBe(200);
    expect((await get('/api/dashboard?mode=demo')).json<Dashboard>().notifications[0]!.read).toBe(
      true,
    );
    const patch = await createFindingPatch('demo', finding.id, 'acknowledged');
    expect(patch.statusCode).toBe(200);
    expect(patch.json().status).toBe('acknowledged');
    expect((await createFindingPatch('live', finding.id, 'acknowledged')).statusCode).toBe(404);
    expect(
      (await post('/api/baselines?mode=demo', { repository: 'northstar/api' })).statusCode,
    ).toBe(200);
    expect(store.baseline('demo', 'northstar/api')?.values.requiredApprovals).toBe(1);
    const live = (await get('/api/dashboard?mode=live')).json<Dashboard>();
    expect(live.repositories).toHaveLength(1);
    expect(live.settings.theme).toBe('light');
    expect(live.findings).toEqual([]);
    expect(live.activity[0]!.kind).toBe('synthetic.fixture');
    expect(github.snapshot).not.toHaveBeenCalled();
    expect(github.execute).not.toHaveBeenCalled();

    function createFindingPatch(mode: string, id: string, status: string) {
      // Use the same authenticated session and CSRF guard as every real mutation.
      return app.inject({
        method: 'PATCH',
        url: `/api/findings/${id}?mode=${mode}`,
        headers,
        payload: { status },
      });
    }
  });

  it('validates settings and persists separate mode preferences across app restart', async () => {
    const context = await harness();
    const settings = {
      ...defaultSettings,
      theme: 'light' as const,
      retentionDays: 30,
      syncIntervalMinutes: 15,
    };
    const put = (body: unknown) =>
      context.app.inject({
        method: 'PUT',
        url: '/api/settings?mode=live',
        headers: context.headers,
        payload: body as Record<string, unknown>,
      });
    expect((await put({ ...settings, syncIntervalMinutes: 1 })).statusCode).toBe(400);
    expect((await put({ ...settings, surprise: true })).statusCode).toBe(400);
    expect((await put(settings)).statusCode).toBe(200);
    expect((await context.get('/api/settings?mode=live')).json()).toEqual(settings);
    expect((await context.get('/api/settings?mode=demo')).json()).toEqual(defaultSettings);
    // Reopen the actual SQLite file instead of merely inspecting in-memory state.
    await context.app.close();
    const reopened = await createApp({
      config: context.config,
      github: context.github,
      background: false,
    });
    cleanups.push(async () => {
      await reopened.app.close();
    });
    expect(reopened.store.settings('live')).toEqual(settings);
    expect(reopened.store.settings('demo')).toEqual(defaultSettings);
  });

  it('creates restorable local backups, bounds rotation, and preserves unrelated files and directories', async () => {
    const { store, post, directory } = await harness();
    store.saveSnapshot('live', snapshot());
    store.saveSettings('live', { ...defaultSettings, retentionDays: 45 });
    const backupDir = join(directory, 'backups');
    mkdirSync(backupDir);
    writeFileSync(join(backupDir, 'operator-notes.txt'), 'Keep this unrelated file.');
    const unrelatedDirectory = 'gitnostics-2020-01-01T00-00-00-000Z-12345678.sqlite';
    mkdirSync(join(backupDir, unrelatedDirectory));
    for (let index = 0; index < 9; index++) {
      const response = await post('/api/backup');
      expect(response.statusCode).toBe(200);
      expect(response.json<{ filename: string }>().filename).toMatch(
        /^gitnostics-[0-9TZ-]+-[a-f0-9]{8}\.sqlite$/,
      );
    }
    const files = readdirSync(backupDir, { withFileTypes: true }).filter(
      (entry) => entry.isFile() && entry.name.endsWith('.sqlite'),
    );
    expect(files).toHaveLength(7);
    expect(readFileSync(join(backupDir, 'operator-notes.txt'), 'utf8')).toBe(
      'Keep this unrelated file.',
    );
    expect(
      readdirSync(backupDir, { withFileTypes: true })
        .find((entry) => entry.name === unrelatedDirectory)
        ?.isDirectory(),
    ).toBe(true);
    const restored = new Store(join(backupDir, files[0]!.name));
    try {
      expect(restored.repositories('live')[0]!.snapshot?.fullName).toBe('northstar/api');
      expect(restored.settings('live').retentionDays).toBe(45);
      expect(restored.repositories('demo')).toEqual([]);
    } finally {
      restored.close();
    }
  });

  it('adds and synchronizes repositories and records sanitized sync failures', async () => {
    const { github, store, post, get } = await harness();
    expect((await post('/api/repositories', { fullName: 'northstar/api' })).json()).toEqual({
      queued: 1,
    });
    await vi.waitFor(() => expect(store.repositories('live')[0]!.snapshot).not.toBeNull());
    expect(github.snapshot).toHaveBeenCalledWith('northstar/api', expect.any(AbortSignal));
    expect((await get('/api/dashboard')).json<Dashboard>().findings.length).toBeGreaterThan(0);
    vi.mocked(github.snapshot).mockRejectedValueOnce(
      new Error('GitHub failed: Bearer synthetic-token ghp_synthetic1234567890'),
    );
    expect((await post('/api/sync', { repository: 'northstar/api' })).json()).toEqual({
      queued: 1,
    });
    await vi.waitFor(() => expect(store.repositories('live')[0]!.syncStatus).toBe('error'));
    expect(store.repositories('live')[0]!.error).not.toMatch(/synthetic/);
    expect(store.repositories('live')[0]!.snapshot).not.toBeNull();
    expect(store.activity('live').some((event) => event.kind === 'sync.error')).toBe(true);
  });

  it('requires an existing synchronized repository before saving a baseline', async () => {
    const { store, post } = await harness();
    expect((await post('/api/baselines', { repository: 'northstar/api' })).statusCode).toBe(404);
    store.upsertRepository('live', 'northstar/api');
    expect((await post('/api/baselines', { repository: 'northstar/api' })).statusCode).toBe(409);
    store.saveSnapshot('live', snapshot());
    expect((await post('/api/baselines', { repository: 'northstar/api' })).statusCode).toBe(200);
    expect(store.baseline('live', 'northstar/api')).toEqual(snapshot().config);
  });

  it('requires precise confirmation, mode matching, and a single-use preview for demo actions', async () => {
    const { post, github, store } = await harness();
    await post('/api/demo/reset');
    const preview = (
      await post('/api/actions/preview?mode=demo', {
        repository: 'northstar/api',
        kind: 'delete_artifacts',
        artifactIds: [501],
      })
    ).json<ActionPreview>();
    expect(preview).toMatchObject({
      mode: 'demo',
      allowed: true,
      destructive: true,
      confirmation: 'SIMULATE',
    });
    expect(preview.impact[0]).toContain('no request will be sent to GitHub');
    expect(
      (
        await post('/api/actions/execute?mode=demo', {
          previewId: preview.id,
          confirmation: 'simulate',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await post('/api/actions/execute?mode=live', {
          previewId: preview.id,
          confirmation: 'SIMULATE',
        })
      ).statusCode,
    ).toBe(409);
    const executed = await post('/api/actions/execute?mode=demo', {
      previewId: preview.id,
      confirmation: 'SIMULATE',
    });
    expect(executed.json()).toMatchObject({ ok: true, simulated: true });
    expect(
      (
        await post('/api/actions/execute?mode=demo', {
          previewId: preview.id,
          confirmation: 'SIMULATE',
        })
      ).statusCode,
    ).toBe(409);
    expect(store.repositories('demo')[0]!.snapshot!.artifacts).toHaveLength(3);
    expect(github.execute).not.toHaveBeenCalled();
    expect(github.snapshot).not.toHaveBeenCalled();
    expect(store.activity('demo').some((event) => event.kind === 'action.success')).toBe(true);
    expect(store.activity('live')).toEqual([]);
  });

  it('rejects invented action targets and ineligible reruns', async () => {
    const { post } = await harness();
    await post('/api/demo/reset');
    for (const action of [
      { kind: 'delete_artifacts', artifactIds: [501, 501] },
      { kind: 'delete_artifacts', artifactIds: [999] },
      { kind: 'rerun_failed', runId: 1003 },
      { kind: 'rerun', runId: 1001 },
      { kind: 'dispatch', workflowId: 999, ref: 'main' },
      { kind: 'dispatch', workflowId: 101, ref: 'unknown' },
    ])
      expect(
        (await post('/api/actions/preview?mode=demo', { repository: 'northstar/api', ...action }))
          .statusCode,
      ).toBe(400);
  });

  it('keeps live executions closed without opt-in or GitHub App permission', async () => {
    const disabled = await harness();
    disabled.store.saveSnapshot('live', snapshot());
    const blocked = (
      await disabled.post('/api/actions/preview', {
        repository: 'northstar/api',
        kind: 'rerun_failed',
        runId: 1000,
      })
    ).json<ActionPreview>();
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(/writes are disabled/);
    expect(
      (
        await disabled.post('/api/actions/execute', {
          previewId: blocked.id,
          confirmation: blocked.confirmation,
        })
      ).statusCode,
    ).toBe(403);
    const denied = await harness({ writes: true, permission: false });
    denied.store.saveSnapshot('live', snapshot());
    const permission = (
      await denied.post('/api/actions/preview', {
        repository: 'northstar/api',
        kind: 'rerun',
        runId: 1000,
      })
    ).json<ActionPreview>();
    expect(permission.allowed).toBe(false);
    expect(permission.reason).toMatch(/write permission/);
    expect(disabled.github.execute).not.toHaveBeenCalled();
    expect(denied.github.execute).not.toHaveBeenCalled();
  });

  it('rechecks operator and installation authorization at execution and clears previews on disconnect', async () => {
    const { store, post, github, connection } = await harness({ writes: true });
    store.saveSnapshot('live', snapshot());
    const preview = (
      await post('/api/actions/preview', {
        repository: 'northstar/api',
        kind: 'rerun_failed',
        runId: 1000,
      })
    ).json<ActionPreview>();
    expect(preview.allowed).toBe(true);
    connection.writesEnabled = false;
    expect(
      (
        await post('/api/actions/execute', {
          previewId: preview.id,
          confirmation: preview.confirmation,
        })
      ).statusCode,
    ).toBe(403);
    connection.writesEnabled = true;
    await post('/api/connection/disconnect');
    expect(
      (
        await post('/api/actions/execute', {
          previewId: preview.id,
          confirmation: preview.confirmation,
        })
      ).statusCode,
    ).toBe(409);
    expect(github.execute).not.toHaveBeenCalled();
    expect(github.disconnect).toHaveBeenCalledOnce();
  });

  it.each(['changed_snapshot', 'deselected', 'permission_revoked', 'stale_snapshot'] as const)(
    'rejects execution when repository evidence becomes %s after preview',
    async (change) => {
      const { store, post, github } = await harness({ writes: true });
      store.saveSnapshot('live', snapshot());
      const preview = (
        await post('/api/actions/preview', {
          repository: 'northstar/api',
          kind: 'rerun_failed',
          runId: 1000,
        })
      ).json<ActionPreview>();
      expect(preview.allowed).toBe(true);
      if (change === 'changed_snapshot')
        store.upsertRepository('live', 'northstar/api', {
          syncedAt: new Date(Date.now() + 1000).toISOString(),
        });
      if (change === 'deselected')
        store.upsertRepository('live', 'northstar/api', { selected: false });
      if (change === 'permission_revoked') {
        const current = snapshot();
        current.permissions.actions = 'read';
        store.upsertRepository('live', 'northstar/api', { snapshot: current });
      }
      if (change === 'stale_snapshot') {
        // An authentic preview can cross the 15-minute freshness threshold before it expires.
        const synchronizedAt = new Date(Date.now() - 14 * 60_000).toISOString();
        store.upsertRepository('live', 'northstar/api', { syncedAt: synchronizedAt });
        const freshPreview = (
          await post('/api/actions/preview', {
            repository: 'northstar/api',
            kind: 'rerun_failed',
            runId: 1000,
          })
        ).json<ActionPreview>();
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 60_000);
        const result = await post('/api/actions/execute', {
          previewId: freshPreview.id,
          confirmation: freshPreview.confirmation,
        });
        expect(result.statusCode).toBe(403);
      } else {
        const result = await post('/api/actions/execute', {
          previewId: preview.id,
          confirmation: preview.confirmation,
        });
        expect(result.statusCode).toBe(change === 'permission_revoked' ? 403 : 409);
      }
      expect(github.execute).not.toHaveBeenCalled();
    },
  );
});
