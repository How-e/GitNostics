import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Store } from './db';

/** Fixed local destination and a seven-file rotation; callers cannot supply paths. */
export class Backups {
  private pending?: Promise<string>;
  private directory: string;
  constructor(
    private store: Store,
    dataDir: string,
  ) {
    this.directory = resolve(dataDir, 'backups');
  }
  private inventory() {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    return readdirSync(this.directory, { withFileTypes: true })
      .filter(
        (entry) => entry.isFile() && /^gitnostics-[0-9TZ-]+-[a-f0-9]{8}\.sqlite$/.test(entry.name),
      )
      .map((entry) => ({
        name: entry.name,
        modified: statSync(resolve(this.directory, entry.name)).mtimeMs,
      }))
      .sort((a, b) => b.modified - a.modified || b.name.localeCompare(a.name));
  }
  async ifDue(hours: number): Promise<void> {
    if (hours <= 0) return;
    const latest = this.inventory()[0];
    if (!latest || Date.now() - latest.modified >= hours * 3600_000) await this.create();
  }
  create(): Promise<string> {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      this.inventory();
      const filename = `gitnostics-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.sqlite`;
      const temporary = resolve(this.directory, `${filename}.partial`);
      try {
        await this.store.backup(temporary);
        renameSync(temporary, resolve(this.directory, filename));
      } catch (error) {
        if (existsSync(temporary)) unlinkSync(temporary);
        throw error;
      }
      // Only enumerated regular files with generated names can be rotated; never directories.
      for (const entry of this.inventory().slice(7))
        unlinkSync(resolve(this.directory, entry.name));
      this.store.audit(
        'live',
        'database.backup',
        'Created a local database backup (maximum seven retained).',
      );
      return filename;
    })().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  async close() {
    await this.pending;
  }
}
