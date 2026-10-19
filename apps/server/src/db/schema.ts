import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { AppSettings, DataMode, RepositorySnapshot } from '@gitnostics/shared';

/** The same contract is used by Drizzle queries and the additive SQL migrations. */
export const repositoriesTable = sqliteTable(
  'repositories',
  {
    mode: text('mode').$type<DataMode>().notNull(),
    fullName: text('full_name').notNull(),
    favorite: integer('favorite', { mode: 'boolean' }).notNull().default(false),
    selected: integer('selected', { mode: 'boolean' }).notNull().default(true),
    syncedAt: text('synced_at'),
    syncStatus: text('sync_status')
      .$type<'idle' | 'queued' | 'syncing' | 'error'>()
      .notNull()
      .default('idle'),
    error: text('error'),
    snapshot: text('snapshot_json', { mode: 'json' }).$type<RepositorySnapshot | null>(),
  },
  (table) => [primaryKey({ columns: [table.mode, table.fullName] })],
);

export const settingsTable = sqliteTable('settings', {
  mode: text('mode').$type<DataMode>().primaryKey(),
  settings: text('settings_json', { mode: 'json' }).$type<AppSettings>().notNull(),
});
