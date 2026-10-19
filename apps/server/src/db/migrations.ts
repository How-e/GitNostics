import type { DatabaseSync } from 'node:sqlite';

// Embedded SQL keeps migrations available in both source execution and bundled releases.
// Never edit an applied migration; append the next version instead.
export const migrations = [
  {
    version: 1,
    name: 'initial-local-store',
    sql: `
      CREATE TABLE repositories (
        mode TEXT NOT NULL CHECK(mode IN ('demo','live')),
        full_name TEXT NOT NULL,
        favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0,1)),
        selected INTEGER NOT NULL DEFAULT 1 CHECK(selected IN (0,1)),
        synced_at TEXT,
        sync_status TEXT NOT NULL DEFAULT 'idle' CHECK(sync_status IN ('idle','queued','syncing','error')),
        error TEXT,
        snapshot_json TEXT,
        PRIMARY KEY(mode,full_name)
      );
      CREATE TABLE settings (
        mode TEXT PRIMARY KEY CHECK(mode IN ('demo','live')),
        settings_json TEXT NOT NULL
      );
      CREATE TABLE findings (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK(mode IN ('demo','live')),
        repository TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('new','active','acknowledged','resolved','suppressed')),
        first_detected_at TEXT NOT NULL,
        last_observed_at TEXT NOT NULL,
        resolved_at TEXT,
        input_json TEXT NOT NULL,
        UNIQUE(mode,repository,rule_id,fingerprint),
        FOREIGN KEY(mode,repository) REFERENCES repositories(mode,full_name) ON DELETE CASCADE
      );
      CREATE INDEX findings_by_repository ON findings(mode,repository,status);
      CREATE TABLE baselines (
        mode TEXT NOT NULL CHECK(mode IN ('demo','live')),
        repository TEXT NOT NULL,
        config_json TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        PRIMARY KEY(mode,repository),
        FOREIGN KEY(mode,repository) REFERENCES repositories(mode,full_name) ON DELETE CASCADE
      );
      CREATE TABLE storage_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mode TEXT NOT NULL CHECK(mode IN ('demo','live')),
        repository TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        bytes INTEGER NOT NULL CHECK(bytes >= 0),
        FOREIGN KEY(mode,repository) REFERENCES repositories(mode,full_name) ON DELETE CASCADE
      );
      CREATE INDEX storage_history_by_mode ON storage_history(mode,captured_at);
      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK(mode IN ('demo','live')),
        kind TEXT NOT NULL,
        repository TEXT,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX audit_by_mode ON audit_events(mode,created_at);
      CREATE TABLE notifications (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK(mode IN ('demo','live')),
        finding_id TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        is_read INTEGER NOT NULL DEFAULT 0 CHECK(is_read IN (0,1)),
        created_at TEXT NOT NULL
      );
      CREATE INDEX notifications_by_mode ON notifications(mode,created_at);
    `,
  },
  {
    version: 2,
    name: 'durable-sync-tasks',
    sql: `
      CREATE TABLE sync_tasks (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK(mode IN ('demo','live')),
        repository TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        error TEXT,
        FOREIGN KEY(mode,repository) REFERENCES repositories(mode,full_name) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX one_pending_task_per_repository ON sync_tasks(mode,repository)
        WHERE status IN ('queued','running');
      CREATE INDEX task_queue ON sync_tasks(mode,status,created_at);
    `,
  },
  {
    version: 3,
    name: 'finding-suppression-provenance',
    sql: `
      ALTER TABLE findings ADD COLUMN suppression_source TEXT CHECK(suppression_source IN ('manual','rule'));
      UPDATE findings SET suppression_source='manual' WHERE status='suppressed';
      CREATE INDEX resolved_finding_retention ON findings(mode,status,resolved_at);
    `,
  },
] as const;

export function migrate(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
  )`);
  const latest = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get();
  if (Number(latest?.version ?? 0) > migrations[migrations.length - 1]!.version) {
    throw new Error(
      'Database schema is newer than this GitNostics version. Upgrade the application.',
    );
  }
  const applied = db.prepare('SELECT version FROM schema_migrations WHERE version = ?');
  const record = db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)');
  for (const migration of migrations) {
    // Check under the write lock so simultaneous startup cannot apply a version twice.
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!applied.get(migration.version)) {
        db.exec(migration.sql);
        record.run(migration.version, migration.name, new Date().toISOString());
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
