import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { Store } from './db';
import { Backups } from './backups';

describe('bounded automatic backups', () => {
  it('preserves an active copy even if its modification time becomes stale', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gitnostics-backup-active-'));
    const store = new Store(join(directory, 'source.sqlite'));
    const backups = new Backups(store, directory);
    const original = store.backup.bind(store);
    let ready!: () => void;
    let release!: () => void;
    const prepared = new Promise<void>((resolve) => (ready = resolve));
    const copyGate = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(store, 'backup').mockImplementationOnce(async (target) => {
      await original(target);
      const old = new Date(Date.now() - 25 * 3600_000);
      utimesSync(target, old, old);
      ready();
      await copyGate;
    });
    try {
      const copy = backups.create();
      await prepared;
      const due = backups.ifDue(24);
      release();
      const filename = await copy;
      await due;
      expect(readdirSync(join(directory, 'backups'))).toEqual([filename]);
    } finally {
      release();
      await backups.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reclaims stale generated crash leftovers while preserving fresh and unrelated paths', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gitnostics-backup-orphans-'));
    const store = new Store(join(directory, 'source.sqlite'));
    const backups = new Backups(store, directory);
    const backupDirectory = join(directory, 'backups');
    mkdirSync(backupDirectory);
    const stale = 'gitnostics-2020-01-01T00-00-00-000Z-abcdef12.sqlite.partial';
    const fresh = 'gitnostics-2020-01-01T00-00-00-000Z-abcdef13.sqlite.partial';
    const unrelated = 'operator-copy.sqlite.partial';
    const folder = 'gitnostics-2020-01-01T00-00-00-000Z-abcdef14.sqlite.partial';
    for (const filename of [stale, fresh, unrelated])
      writeFileSync(join(backupDirectory, filename), 'unfinished');
    mkdirSync(join(backupDirectory, folder));
    const old = new Date(Date.now() - 25 * 3600_000);
    for (const filename of [stale, unrelated, folder])
      utimesSync(join(backupDirectory, filename), old, old);
    try {
      await backups.ifDue(24);
      expect(readdirSync(backupDirectory)).not.toContain(stale);
      expect(readdirSync(backupDirectory)).toEqual(
        expect.arrayContaining([fresh, unrelated, folder]),
      );
      for (let i = 0; i < 8; i++) await backups.create();
      expect(readdirSync(backupDirectory).filter((name) => name.endsWith('.sqlite'))).toHaveLength(
        7,
      );
      // Inventory also reclaims an aged orphan when a completed backup is not due.
      utimesSync(join(backupDirectory, fresh), old, old);
      await backups.ifDue(24);
      expect(readdirSync(backupDirectory)).not.toContain(fresh);
      expect(readFileSync(join(backupDirectory, unrelated), 'utf8')).toBe('unfinished');
      expect(readdirSync(join(backupDirectory, folder))).toEqual([]);
    } finally {
      await backups.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('removes an interrupted copy and retries without treating a partial file as success', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gitnostics-backup-failure-'));
    const store = new Store(join(directory, 'source.sqlite'));
    const backups = new Backups(store, directory);
    const original = store.backup.bind(store);
    const copy = vi
      .spyOn(store, 'backup')
      .mockImplementationOnce(async (target) => {
        writeFileSync(target, 'partial');
        throw new Error('Interrupted backup');
      })
      .mockImplementation(original);
    try {
      await expect(backups.ifDue(24)).rejects.toThrow('Interrupted backup');
      expect(readdirSync(join(directory, 'backups'))).toEqual([]);
      await backups.ifDue(24);
      expect(copy).toHaveBeenCalledTimes(2);
      expect(readdirSync(join(directory, 'backups'))).toHaveLength(1);
    } finally {
      await backups.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('coalesces concurrent copies, retains seven valid snapshots and preserves unrelated paths', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gitnostics-backup-'));
    const store = new Store(join(directory, 'source.sqlite'));
    const backups = new Backups(store, directory);
    try {
      store.upsertRepository('live', 'example/repository');
      const first = await Promise.all([backups.create(), backups.create()]);
      expect(first[0]).toBe(first[1]);
      const backupDirectory = join(directory, 'backups');
      writeFileSync(join(backupDirectory, 'keep.txt'), 'keep');
      mkdirSync(join(backupDirectory, 'gitnostics-2020-01-01T00-00-00-000Z-abcdef12.sqlite'));
      for (let i = 0; i < 8; i++) await backups.create();
      const files = readdirSync(backupDirectory, { withFileTypes: true }).filter(
        (item) => item.isFile() && item.name.endsWith('.sqlite'),
      );
      expect(files).toHaveLength(7);
      expect(readFileSync(join(backupDirectory, 'keep.txt'), 'utf8')).toBe('keep');
      const restored = new DatabaseSync(join(backupDirectory, files[0].name), { readOnly: true });
      expect(restored.prepare('SELECT full_name FROM repositories').get()).toMatchObject({
        full_name: 'example/repository',
      });
      restored.close();
      const before = readdirSync(backupDirectory).sort();
      await backups.ifDue(0);
      await backups.ifDue(24);
      expect(readdirSync(backupDirectory).sort()).toEqual(before);
    } finally {
      await backups.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
