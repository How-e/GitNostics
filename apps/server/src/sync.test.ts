import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RepositorySnapshot } from '@gitnostics/shared';
import { Store } from './db';
import { demoSnapshots } from './demo';
import { SyncManager, type SnapshotClient } from './sync';

const contexts: { store: Store; sync: SyncManager }[] = [];

function context(client: SnapshotClient) {
  const store = new Store(':memory:');
  const sync = new SyncManager(store, client);
  contexts.push({ store, sync });
  return { store, sync };
}

function deferredSnapshot() {
  let resolve!: (snapshot: RepositorySnapshot) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<RepositorySnapshot>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(async () => {
  for (const { store, sync } of contexts.splice(0)) {
    await sync.close();
    store.close();
  }
});

describe('synchronization orchestration without outbound GitHub requests', () => {
  it('schedules and completes work without loading unrelated repository snapshots', async () => {
    const { store, sync } = context({ snapshot: vi.fn(async () => demoSnapshots()[0]!) });
    store.upsertRepository('live', 'northstar/api');
    const fullReads = vi.spyOn(store, 'repositories').mockImplementation(() => {
      throw new Error('Scheduling must read repository metadata only');
    });
    expect(sync.queue('live')).toBe(1);
    await vi.waitFor(() => expect(store.tasks('live')[0]!.status).toBe('completed'));
    expect(fullReads).not.toHaveBeenCalled();
  });

  it('preserves acknowledged PR evidence through incomplete sync and resolves it only with complete collection', async () => {
    const snapshot = demoSnapshots()[0]!;
    const complete = { pullRequests: true, runs: true, artifacts: true, config: true };
    snapshot.collectionState = complete;
    const partial: RepositorySnapshot = {
      ...snapshot,
      pullRequests: [],
      collectionState: { ...complete, pullRequests: false },
      warnings: ['Synthetic partial PR collection'],
    };
    const client: SnapshotClient = {
      snapshot: vi
        .fn()
        .mockResolvedValueOnce(snapshot)
        .mockResolvedValueOnce(partial)
        .mockResolvedValueOnce({ ...partial, collectionState: complete, warnings: [] }),
    };
    const { store, sync } = context(client);
    store.upsertRepository('live', snapshot.fullName);
    sync.queue('live');
    await vi.waitFor(() => expect(store.tasks('live')[0]!.status).toBe('completed'));
    const conflict = store
      .findings('live')
      .find((finding) => finding.ruleId === 'pr.merge-conflict')!;
    expect(conflict).toBeDefined();
    store.updateFinding('live', conflict.id, 'acknowledged');
    sync.queue('live');
    await vi.waitFor(() =>
      expect(store.tasks('live').filter((task) => task.status === 'completed')).toHaveLength(2),
    );
    expect(store.findings('live').find((finding) => finding.id === conflict.id)!.status).toBe(
      'acknowledged',
    );
    expect(store.repositories('live')[0]!.snapshot!.warnings).toContain(
      'Synthetic partial PR collection',
    );
    sync.queue('live');
    await vi.waitFor(() =>
      expect(store.tasks('live').filter((task) => task.status === 'completed')).toHaveLength(3),
    );
    expect(store.findings('live').find((finding) => finding.id === conflict.id)!.status).toBe(
      'resolved',
    );
    expect(store.repositories('demo')).toEqual([]);
  });

  it('spaces automatic retries by the configured interval after failure and restart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
    const client: SnapshotClient = {
      snapshot: vi.fn(async () => {
        throw new Error('Synthetic upstream outage');
      }),
    };
    const { store, sync } = context(client);
    try {
      store.saveSnapshot('live', demoSnapshots()[0]!);
      store.saveSettings('live', { ...store.settings('live'), syncIntervalMinutes: 5 });
      vi.setSystemTime(new Date('2026-10-18T12:10:00Z'));
      // Simulate a failed attempt recovered from a prior process.
      const failed = store.enqueueTask('live', 'northstar/api');
      store.finishTask(failed.id, 'Synthetic upstream outage');
      sync.start();
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(client.snapshot).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(client.snapshot).toHaveBeenCalledTimes(1);
      expect(store.repositories('live')[0]!.syncStatus).toBe('error');
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(client.snapshot).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(client.snapshot).toHaveBeenCalledTimes(2);
      // An operator may explicitly retry immediately.
      expect(sync.queue('live', 'northstar/api')).toBe(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(client.snapshot).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('limits concurrency to two, coalesces duplicate requests, and ignores deselected repositories', async () => {
    const calls = new Map<string, ReturnType<typeof deferredSnapshot>>();
    const client: SnapshotClient = {
      snapshot: vi.fn((repository: string) => {
        const pending = deferredSnapshot();
        calls.set(repository, pending);
        return pending.promise;
      }),
    };
    const { store, sync } = context(client);
    for (const repository of [
      'northstar/api',
      'northstar/web',
      'northstar/toolkit',
      'northstar/ignored',
    ])
      store.upsertRepository('live', repository, { selected: repository !== 'northstar/ignored' });
    expect(sync.queue('live')).toBe(3);
    expect(sync.queue('live')).toBe(0);
    expect(client.snapshot).toHaveBeenCalledTimes(2);
    expect(store.tasks('live').filter((task) => task.status === 'queued')).toHaveLength(1);
    calls.get('northstar/api')!.resolve(demoSnapshots()[0]!);
    await vi.waitFor(() => expect(client.snapshot).toHaveBeenCalledTimes(3));
    calls.get('northstar/web')!.resolve(demoSnapshots()[1]!);
    calls.get('northstar/toolkit')!.resolve(demoSnapshots()[2]!);
    await vi.waitFor(() =>
      expect(store.tasks('live').filter((task) => task.status === 'completed')).toHaveLength(3),
    );
    expect(
      store.repositories('live').find((repository) => repository.fullName === 'northstar/ignored')!
        .snapshot,
    ).toBeNull();
  });

  it('cancels running and queued work without starting additional requests or discarding cached snapshots', async () => {
    const client: SnapshotClient = {
      snapshot: vi.fn(
        (_repository: string, signal?: AbortSignal) =>
          new Promise<RepositorySnapshot>((_resolve, reject) => {
            signal!.addEventListener(
              'abort',
              () => reject(new Error('Aborted synthetic snapshot')),
              { once: true },
            );
          }),
      ),
    };
    const { store, sync } = context(client);
    for (const snapshot of demoSnapshots()) store.saveSnapshot('live', snapshot);
    expect(sync.queue('live')).toBe(3);
    expect(sync.cancel('live')).toBe(3);
    await vi.waitFor(() =>
      expect(
        store.repositories('live').every((repository) => repository.syncStatus === 'idle'),
      ).toBe(true),
    );
    expect(client.snapshot).toHaveBeenCalledTimes(2);
    expect(
      store
        .repositories('live')
        .every((repository) => repository.snapshot !== null && repository.error === null),
    ).toBe(true);
    expect(store.tasks('live').every((task) => !['queued', 'running'].includes(task.status))).toBe(
      true,
    );
    expect(store.activity('live').filter((event) => event.kind === 'sync.cancelled')).toHaveLength(
      2,
    );
  });

  it('does not recreate repositories removed while an outbound read was pending', async () => {
    const pending = deferredSnapshot();
    const { store, sync } = context({ snapshot: vi.fn(() => pending.promise) });
    store.upsertRepository('live', 'northstar/api');
    sync.queue('live');
    store.removeRepository('live', 'northstar/api');
    pending.resolve(demoSnapshots()[0]!);
    await vi.waitFor(() =>
      expect(store.tasks('live').every((task) => task.status !== 'running')).toBe(true),
    );
    expect(store.repositories('live')).toEqual([]);
    expect(store.findings('live')).toEqual([]);
  });

  it('never invokes the GitHub snapshot client for demo refreshes', async () => {
    const client: SnapshotClient = {
      snapshot: vi.fn(async () => {
        throw new Error('Demo must never contact GitHub');
      }),
    };
    const { store, sync } = context(client);
    store.upsertRepository('demo', 'northstar/api');
    expect(sync.queue('demo')).toBe(1);
    await vi.waitFor(() => expect(store.repositories('demo')[0]!.snapshot).not.toBeNull());
    expect(store.repositories('demo')[0]!.syncStatus).toBe('idle');
    expect(store.findings('demo').length).toBeGreaterThan(0);
    expect(client.snapshot).not.toHaveBeenCalled();
    expect(store.repositories('live')).toEqual([]);
  });

  it('records failures without losing prior data and retries as a separate durable task', async () => {
    const snapshot = demoSnapshots()[0]!;
    const client: SnapshotClient = {
      snapshot: vi
        .fn()
        .mockRejectedValueOnce(new Error('HTTP 503 Bearer synthetic-only'))
        .mockResolvedValueOnce(snapshot),
    };
    const { store, sync } = context(client);
    store.saveSnapshot('live', snapshot);
    sync.queue('live');
    await vi.waitFor(() => expect(store.repositories('live')[0]!.syncStatus).toBe('error'));
    expect(store.repositories('live')[0]!.error).toContain('[REDACTED');
    expect(store.repositories('live')[0]!.error).not.toContain('synthetic-only');
    expect(store.repositories('live')[0]!.snapshot).toEqual(snapshot);
    expect(sync.queue('live')).toBe(1);
    await vi.waitFor(() => expect(store.repositories('live')[0]!.syncStatus).toBe('idle'));
    expect(store.tasks('live').map((task) => task.status)).toEqual(['completed', 'failed']);
    expect(store.storageHistory('live')).toHaveLength(2);
  });

  it('stops accepting new tasks after shutdown', async () => {
    const client: SnapshotClient = { snapshot: vi.fn(async () => demoSnapshots()[0]!) };
    const { store, sync } = context(client);
    store.upsertRepository('live', 'northstar/api');
    await sync.close();
    expect(sync.queue('live')).toBe(0);
    expect(client.snapshot).not.toHaveBeenCalled();
  });

  it('cancels a deselected queued repository before starting its GitHub request', async () => {
    const api = deferredSnapshot();
    const toolkit = deferredSnapshot();
    const client: SnapshotClient = {
      snapshot: vi.fn((repository) =>
        repository === 'northstar/api' ? api.promise : toolkit.promise,
      ),
    };
    const { store, sync } = context(client);
    for (const repository of ['northstar/api', 'northstar/web', 'northstar/toolkit'])
      store.upsertRepository('live', repository);
    expect(sync.queue('live')).toBe(3);
    store.upsertRepository('live', 'northstar/web', { selected: false });
    api.resolve(demoSnapshots()[0]!);
    toolkit.resolve(demoSnapshots()[2]!);
    await vi.waitFor(() =>
      expect(
        store.tasks('live').every((task) => !['queued', 'running'].includes(task.status)),
      ).toBe(true),
    );
    expect(client.snapshot).toHaveBeenCalledTimes(2);
    expect(store.tasks('live').find((task) => task.repository === 'northstar/web')!.status).toBe(
      'cancelled',
    );
    expect(
      store.repositories('live').find((repository) => repository.fullName === 'northstar/web')!
        .snapshot,
    ).toBeNull();
  });

  it('rejects a snapshot for a different repository before persisting any of its data', async () => {
    const { store, sync } = context({ snapshot: vi.fn(async () => demoSnapshots()[1]!) });
    store.upsertRepository('live', 'northstar/api');
    sync.queue('live');
    await vi.waitFor(() => expect(store.repositories('live')[0]!.syncStatus).toBe('error'));
    expect(store.repositories('live')).toHaveLength(1);
    expect(store.repositories('live')[0]!.snapshot).toBeNull();
    expect(store.repositories('live')[0]!.error).toMatch(/identity/);
    expect(store.storageHistory('live')).toEqual([]);
    expect(store.findings('live')).toEqual([]);
  });
});
