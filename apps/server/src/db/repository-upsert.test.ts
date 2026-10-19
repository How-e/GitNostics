import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositorySnapshot } from '@gitnostics/shared';
import { Store } from './index.js';

const directories: string[] = [];
const stores: Store[] = [];
function open(file = ':memory:'): Store {
  const store = new Store(file);
  stores.push(store);
  return store;
}
function snapshot(): RepositorySnapshot {
  return {
    fullName: 'example/project',
    name: 'project',
    owner: 'example',
    description: 'Local fixture',
    url: 'https://github.com/example/project',
    private: false,
    defaultBranch: 'main',
    language: 'TypeScript',
    stars: 1,
    openIssues: 0,
    updatedAt: '2026-10-01T00:00:00.000Z',
    permissions: { actions: 'read', administration: 'unknown' },
    pullRequests: [],
    runs: [],
    artifacts: [],
    config: { values: {}, inaccessible: [] },
    warnings: [],
  };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('repository partial updates', () => {
  it('uses defaults for new repositories, ignores identity patches and isolates modes', () => {
    const store = open();
    store.upsertRepository('live', 'example/project', {
      favorite: true,
      fullName: 'other/project',
      mode: 'demo',
    });
    expect(store.repositories('live')).toEqual([
      {
        mode: 'live',
        fullName: 'example/project',
        favorite: true,
        selected: true,
        syncedAt: null,
        syncStatus: 'idle',
        error: null,
        snapshot: null,
      },
    ]);
    store.upsertRepository('demo', 'example/project');
    expect(store.repositories('demo')[0]?.favorite).toBe(false);
    store.upsertRepository('live', 'example/project', { selected: false, syncStatus: 'queued' });
    store.upsertRepository('live', 'example/project');
    expect(store.repositories('live')[0]).toMatchObject({
      favorite: true,
      selected: false,
      syncStatus: 'queued',
    });
    expect(store.repositories('demo')[0]).toMatchObject({ selected: true, syncStatus: 'idle' });
    expect(() => store.upsertRepository('live', 'invalid')).toThrow();
  });

  it('preserves exact snapshot bytes and omitted fields during metadata-only updates', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gitnostics-upsert-'));
    directories.push(directory);
    const file = join(directory, 'store.sqlite');
    const store = open(file);
    store.upsertRepository('live', 'example/project', {
      snapshot: snapshot(),
      syncedAt: '2026-10-02T00:00:00.000Z',
      error: 'Existing diagnostic message',
    });
    const raw = new DatabaseSync(file);
    try {
      const bytes = JSON.stringify(snapshot(), null, 2);
      raw.prepare('UPDATE repositories SET snapshot_json=?').run(bytes);
      // Enforce the storage boundary without relying on a timing threshold.
      raw.exec(`CREATE TRIGGER reject_snapshot_rewrite BEFORE UPDATE OF snapshot_json ON repositories
        BEGIN SELECT RAISE(ABORT, 'Snapshot must remain untouched'); END`);
      store.upsertRepository('live', 'example/project', { favorite: true });
      store.upsertRepository('live', 'example/project', { selected: false });
      store.upsertRepository('live', 'example/project', { syncStatus: 'queued' });
      store.upsertRepository('live', 'example/project');
      expect(raw.prepare('SELECT snapshot_json FROM repositories').get()?.snapshot_json).toBe(
        bytes,
      );
      expect(store.repositories('live')[0]).toMatchObject({
        favorite: true,
        selected: false,
        syncStatus: 'queued',
        syncedAt: '2026-10-02T00:00:00.000Z',
        error: 'Existing diagnostic message',
        snapshot: snapshot(),
      });
    } finally {
      raw.close();
    }
  });

  it('keeps supplied snapshots bounded, redacted, owned and atomic on rejection', () => {
    const store = open();
    store.upsertRepository('live', 'example/project', {
      snapshot: { ...snapshot(), description: 'token=synthetic-private-value' },
      error: 'password=synthetic-private-value',
    });
    const saved = store.repositories('live');
    expect(saved[0]?.snapshot?.description).not.toContain('synthetic-private-value');
    expect(saved[0]?.error).not.toContain('synthetic-private-value');
    expect(() =>
      store.upsertRepository('live', 'example/project', {
        snapshot: { ...snapshot(), fullName: 'other/project' },
        favorite: true,
      }),
    ).toThrow('does not belong');
    expect(() =>
      store.upsertRepository('live', 'example/project', {
        snapshot: {
          ...snapshot(),
          warnings: Array.from({ length: 130 }, () => 'x'.repeat(65_536)),
        },
        favorite: true,
      }),
    ).toThrow('bounded size');
    expect(store.repositories('live')).toEqual(saved);
  });

  it('preserves explicit nullable and undefined patch behavior', () => {
    const store = open();
    store.upsertRepository('live', 'example/project', { snapshot: snapshot(), error: 'message' });
    store.upsertRepository('live', 'example/project', { snapshot: null, error: null });
    expect(store.repositories('live')[0]).toMatchObject({ snapshot: null, error: null });
    store.upsertRepository('live', 'example/project', { snapshot: snapshot(), error: 'message' });
    store.upsertRepository('live', 'example/project', { snapshot: undefined, error: undefined });
    expect(store.repositories('live')[0]).toMatchObject({ snapshot: null, error: null });
    for (const patch of [
      { syncedAt: undefined },
      { syncStatus: undefined },
      { favorite: undefined },
      { selected: undefined },
    ])
      expect(() => store.upsertRepository('live', 'example/project', patch)).toThrow();
    expect(store.repositories('live')[0]).toMatchObject({ favorite: false, selected: true });
  });
});
