import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Store } from './db';

const backupFilename = /^gitnostics-[0-9TZ-]+-[a-f0-9]{8}\.sqlite$/;
const interruptedCopyAgeMs = 24 * 3600_000;

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
    const entries = readdirSync(this.directory, { withFileTypes: true });
    // A killed process cannot execute catch cleanup. Reclaim only generated copies
    // untouched for a day, and never clean while this instance has an active copy.
    // Fresh partials may belong to another instance and must be left alone.
    if (!this.pending)
      for (const entry of entries) {
        if (
          !entry.isFile() ||
          !entry.name.endsWith('.partial') ||
          !backupFilename.test(entry.name.slice(0, -'.partial'.length))
        )
          continue;
        const partial = resolve(this.directory, entry.name);
        if (Date.now() - statSync(partial).mtimeMs >= interruptedCopyAgeMs) unlinkSync(partial);
      }
    return entries
      .filter((entry) => entry.isFile() && backupFilename.test(entry.name))
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
      // Always retain the copy just completed, even after a backward clock change.
      // Only enumerated regular files with generated names can be rotated; never directories.
      for (const entry of this.inventory()
        .filter((entry) => entry.name !== filename)
        .slice(6))
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
