import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { backup, DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import {
  defaultSettings,
  repoNameSchema,
  settingsSchema,
  severityWeight,
  type AppSettings,
  type AuditEvent,
  type DataMode,
  type Finding,
  type FindingInput,
  type FindingStatus,
  type Notification,
  type RepositoryConfig,
  type RepositoryRecord,
  type RepositorySnapshot,
} from '@gitnostics/shared';
import { migrate } from './migrations.js';
import { repositoriesTable, settingsTable } from './schema.js';

type RepositoryRow = {
  mode: DataMode;
  full_name: string;
  favorite: number;
  selected: number;
  synced_at: string | null;
  sync_status: RepositoryRecord['syncStatus'];
  error: string | null;
  snapshot_json: string | null;
};
type FindingRow = {
  id: string;
  mode: DataMode;
  repository: string;
  rule_id: string;
  fingerprint: string;
  status: FindingStatus;
  first_detected_at: string;
  last_observed_at: string;
  resolved_at: string | null;
  suppression_source: 'manual' | 'rule' | null;
  acknowledged_before_rule_suppression: number;
  input_json: string;
};
export interface SyncTask {
  id: string;
  mode: DataMode;
  repository: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}
type TaskRow = {
  id: string;
  mode: DataMode;
  repository: string;
  status: SyncTask['status'];
  attempts: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
};
const now = (): string => new Date().toISOString();
const validStatuses = new Set<FindingStatus>([
  'new',
  'active',
  'acknowledged',
  'resolved',
  'suppressed',
]);

/** Defense in depth: credentials never belong in a persisted diagnostic or audit message. */
export function redactStoredText(text: string): string {
  return text
    .slice(0, 65_536)
    .replace(
      /(["'])((?:set-)?cookie[ \t]*:[ \t]*)(?:\\.|(?!\1)[^\\\r\n])*(?:\1|(?=\r?\n|$))|(\b(?:set-)?cookie\b["'][ \t]*[:=][ \t]*)(?:(["'])(?:\\.|(?!\4)[^\\\r\n])*(?:\4|(?=\r?\n|$))|[^\r\n]*)|(\b(?:set-)?cookie\b[ \t]*[:=][ \t]*)[^\r\n]*/gi,
      (
        _match,
        headerQuote: string | undefined,
        header: string | undefined,
        prefix: string | undefined,
        valueQuote: string | undefined,
        rawPrefix: string | undefined,
      ) =>
        headerQuote
          ? `${headerQuote}${header}[REDACTED COOKIE]${headerQuote}`
          : `${prefix ?? rawPrefix}${valueQuote ?? ''}[REDACTED COOKIE]${valueQuote ?? ''}`,
    )
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      '[REDACTED PRIVATE KEY]',
    )
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+\b/g, '[REDACTED]')
    .replace(/\bAKIA[A-Z0-9]+\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/(\b(?:proxy-)?authorization\s*:\s*)[^\r\n]+/gi, '$1[REDACTED AUTHORIZATION]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=:-]+/gi, '[REDACTED AUTHORIZATION]')
    .replace(
      /(\b(?:[A-Za-z][A-Za-z0-9_]*_)?(?:token|api[_-]?key|secret|password|passwd|client[_-]?secret|access[_-]?token|refresh[_-]?token|authorization|private[_-]?key|aws[_-]?secret[_-]?access[_-]?key)\b["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*"?|'(?:\\.|[^'\\\r\n])*'?|[^\s,;&]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(
      /([?&](?:token|key|api_key|signature|sig|x-amz-signature|x-amz-credential|x-amz-security-token)=)[^&#\s"'<>]*/gi,
      '$1[REDACTED]',
    )
    .slice(0, 65_536);
}
function encoded(value: unknown, maximumBytes = 8 * 1024 * 1024): string {
  const json = JSON.stringify(value, (key, item: unknown) => {
    if (typeof item !== 'string') return item;
    if (
      /^(?:password|passwd|client_secret|access_token|refresh_token|api[_-]?key|authorization)$/i.test(
        key,
      )
    )
      return '[REDACTED]';
    return redactStoredText(item);
  });
  if (json === undefined || Buffer.byteLength(json) > maximumBytes)
    throw new Error('Persistence payload exceeds its bounded size.');
  return json;
}
function repositorySummary(
  row: Omit<RepositoryRow, 'snapshot_json'>,
): Omit<RepositoryRecord, 'snapshot'> {
  return {
    fullName: row.full_name,
    mode: row.mode,
    favorite: Boolean(row.favorite),
    selected: Boolean(row.selected),
    syncedAt: row.synced_at,
    syncStatus: row.sync_status,
    error: row.error,
  };
}
function repositoryRecord(row: RepositoryRow): RepositoryRecord {
  return {
    ...repositorySummary(row),
    snapshot: row.snapshot_json ? (JSON.parse(row.snapshot_json) as RepositorySnapshot) : null,
  };
}
function findingRecord(row: FindingRow): Finding {
  return {
    ...(JSON.parse(row.input_json) as FindingInput),
    id: row.id,
    mode: row.mode,
    status: row.status,
    firstDetectedAt: row.first_detected_at,
    lastObservedAt: row.last_observed_at,
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
  };
}
function taskRecord(row: TaskRow): SyncTask {
  return {
    id: row.id,
    mode: row.mode,
    repository: row.repository,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
  };
}

export class Store {
  readonly #db: DatabaseSync;
  readonly #path: string;
  // Stable Drizzle's proxy driver is async; transactions and task claims use the native
  // synchronous connection while public async query methods execute actual typed ORM SQL.
  readonly #orm;

  constructor(path: string) {
    this.#path = path === ':memory:' ? path : resolve(path);
    if (this.#path !== ':memory:') mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(this.#path);
    try {
      this.#db.exec(
        'PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;',
      );
      if (this.#path !== ':memory:') chmodSync(this.#path, 0o600);
      migrate(this.#db);
      this.#orm = drizzle(
        async (sql, params, method) => {
          const statement = this.#db.prepare(sql);
          if (method === 'run') {
            statement.run(...(params as SQLInputValue[]));
            return { rows: [] };
          }
          statement.setReturnArrays(true);
          // @types/node retains object-row typing after setReturnArrays(true).
          const rows = statement.all(...(params as SQLInputValue[])) as unknown as unknown[][];
          return { rows: method === 'get' ? (rows[0] ?? []) : rows };
        },
        { schema: { repositoriesTable, settingsTable } },
      );
      this.recoverTasks();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }

  #all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.#db.prepare(sql).all(...params) as unknown as T[];
  }
  #get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.#db.prepare(sql).get(...params) as unknown as T | undefined;
  }
  #transaction<T>(operation: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  repositories(mode: DataMode): RepositoryRecord[] {
    return this.#all<RepositoryRow>(
      'SELECT * FROM repositories WHERE mode = ? ORDER BY full_name COLLATE NOCASE',
      mode,
    ).map(repositoryRecord);
  }
  repositorySummaries(mode: DataMode): Omit<RepositoryRecord, 'snapshot'>[] {
    return this.#all<Omit<RepositoryRow, 'snapshot_json'>>(
      `SELECT mode,full_name,favorite,selected,synced_at,sync_status,error
       FROM repositories WHERE mode = ? ORDER BY full_name COLLATE NOCASE`,
      mode,
    ).map(repositorySummary);
  }
  async queryRepositories(mode: DataMode): Promise<RepositoryRecord[]> {
    const rows = await this.#orm
      .select()
      .from(repositoriesTable)
      .where(eq(repositoriesTable.mode, mode))
      .orderBy(repositoriesTable.fullName);
    return rows.map((row) => ({ ...row, snapshot: row.snapshot ?? null }));
  }
  upsertRepository(mode: DataMode, fullName: string, patch: Partial<RepositoryRecord> = {}): void {
    repoNameSchema.parse(fullName);
    const columns = ['mode', 'full_name'];
    const values: SQLInputValue[] = [mode, fullName];
    const updates: string[] = [];
    const include = (column: string, value: SQLInputValue | undefined): void => {
      if (value === undefined) throw new Error('Repository patch contains an undefined value.');
      columns.push(column);
      values.push(value);
      updates.push(`${column}=excluded.${column}`);
    };
    // Only fixed, explicitly supplied fields become SQL columns. In particular,
    // status and preference changes must not parse or re-encode a large snapshot.
    // New repositories use the same defaults declared by the versioned schema.
    if (Object.hasOwn(patch, 'favorite')) include('favorite', Number(patch.favorite));
    if (Object.hasOwn(patch, 'selected')) include('selected', Number(patch.selected));
    if (Object.hasOwn(patch, 'syncedAt')) include('synced_at', patch.syncedAt);
    if (Object.hasOwn(patch, 'syncStatus')) include('sync_status', patch.syncStatus);
    if (Object.hasOwn(patch, 'error'))
      include('error', patch.error ? redactStoredText(patch.error).slice(0, 2000) : null);
    if (Object.hasOwn(patch, 'snapshot')) {
      if (patch.snapshot && patch.snapshot.fullName !== fullName)
        throw new Error('Snapshot does not belong to this repository.');
      include('snapshot_json', patch.snapshot ? encoded(patch.snapshot) : null);
    }
    this.#db
      .prepare(
        `INSERT INTO repositories(${columns.join(',')}) VALUES(${values.map(() => '?').join(',')})
         ON CONFLICT(mode,full_name) ${updates.length ? `DO UPDATE SET ${updates.join(',')}` : 'DO NOTHING'}`,
      )
      .run(...values);
  }
  removeRepository(mode: DataMode, fullName: string): void {
    this.#transaction(() => {
      this.#db
        .prepare('DELETE FROM audit_events WHERE mode = ? AND repository = ?')
        .run(mode, fullName);
      this.#db
        .prepare('DELETE FROM repositories WHERE mode = ? AND full_name = ?')
        .run(mode, fullName);
    });
  }
  saveSnapshot(mode: DataMode, snapshot: RepositorySnapshot): void {
    const capturedAt = now();
    const bounded = {
      ...snapshot,
      runs: snapshot.runs.map((run) => ({
        ...run,
        jobs: run.jobs.map((job) => ({
          ...job,
          ...(job.logExcerpt === undefined
            ? {}
            : { logExcerpt: redactStoredText(job.logExcerpt).slice(0, 16_384) }),
        })),
      })),
    };
    if (
      snapshot.artifacts.some(
        (artifact) => !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0,
      )
    )
      throw new Error('Invalid artifact storage size.');
    const bytes = snapshot.artifacts
      .filter((artifact) => !artifact.expired)
      .reduce((total, artifact) => total + artifact.sizeBytes, 0);
    if (!Number.isSafeInteger(bytes)) throw new Error('Invalid artifact storage size.');
    this.#transaction(() => {
      this.upsertRepository(mode, snapshot.fullName, {
        snapshot: bounded,
        syncedAt: capturedAt,
        syncStatus: 'idle',
        error: null,
      });
      if (snapshot.collectionState?.artifacts !== false) {
        this.#db
          .prepare('INSERT INTO storage_history(mode,repository,captured_at,bytes) VALUES(?,?,?,?)')
          .run(mode, snapshot.fullName, capturedAt, bytes);
      }
      this.#db
        .prepare(
          'DELETE FROM storage_history WHERE mode = ? AND id NOT IN (SELECT id FROM storage_history WHERE mode = ? ORDER BY id DESC LIMIT 5000)',
        )
        .run(mode, mode);
    });
  }

  findings(mode: DataMode): Finding[] {
    return this.#all<FindingRow>(
      'SELECT * FROM findings WHERE mode = ? ORDER BY last_observed_at DESC,id',
      mode,
    ).map(findingRecord);
  }
  reconcileFindings(
    mode: DataMode,
    repository: string,
    inputs: FindingInput[],
    suppressedRules: string[] = [],
    authoritativeTypes: FindingInput['type'][] = [
      'pull_request',
      'workflow',
      'configuration',
      'storage',
    ],
  ): void {
    if (inputs.some((input) => input.repository !== repository))
      throw new Error('Finding does not belong to this repository.');
    const timestamp = now();
    const preferences = this.settings(mode);
    const suppressed = new Set([...preferences.suppressedRules, ...suppressedRules]);
    const authoritative = new Set(authoritativeTypes);
    this.#transaction(() => {
      this.upsertRepository(mode, repository);
      const existing = this.#all<FindingRow>(
        'SELECT * FROM findings WHERE mode = ? AND repository = ?',
        mode,
        repository,
      );
      const byId = new Map(existing.map((row) => [row.id, row]));
      const seen = new Set<string>();
      const statement = this.#db
        .prepare(`INSERT INTO findings(id,mode,repository,rule_id,fingerprint,status,first_detected_at,last_observed_at,resolved_at,input_json,suppression_source,acknowledged_before_rule_suppression)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,
        last_observed_at=excluded.last_observed_at,resolved_at=NULL,input_json=excluded.input_json,suppression_source=excluded.suppression_source,
        acknowledged_before_rule_suppression=excluded.acknowledged_before_rule_suppression`);
      for (const input of inputs) {
        const id = createHash('sha256')
          .update(JSON.stringify([mode, repository, input.ruleId, input.fingerprint]))
          .digest('hex')
          .slice(0, 32);
        if (seen.has(id)) continue;
        seen.add(id);
        const old = byId.get(id);
        const suppressionSource =
          old?.suppression_source === 'manual'
            ? 'manual'
            : suppressed.has(input.ruleId)
              ? 'rule'
              : null;
        const status: FindingStatus = suppressionSource
          ? 'suppressed'
          : old?.status === 'acknowledged' ||
              (old?.suppression_source === 'rule' && old.acknowledged_before_rule_suppression === 1)
            ? 'acknowledged'
            : old
              ? 'active'
              : 'new';
        statement.run(
          id,
          mode,
          repository,
          input.ruleId,
          input.fingerprint,
          status,
          old?.first_detected_at ?? timestamp,
          timestamp,
          null,
          encoded(input, 512 * 1024),
          suppressionSource,
          Number(
            suppressionSource === 'rule' &&
              (old?.status === 'acknowledged' || old?.acknowledged_before_rule_suppression === 1),
          ),
        );
        if (
          (!old || old.status === 'resolved') &&
          status !== 'suppressed' &&
          preferences.notificationsEnabled &&
          severityWeight[input.severity] >= severityWeight[preferences.minimumSeverity]
        ) {
          this.#db
            .prepare(
              'INSERT INTO notifications(id,mode,finding_id,title,is_read,created_at) VALUES(?,?,?,?,0,?)',
            )
            .run(randomUUID(), mode, id, redactStoredText(input.title).slice(0, 500), timestamp);
        }
      }
      const resolveFinding = this.#db.prepare(
        "UPDATE findings SET status='resolved',resolved_at=?,suppression_source=NULL,acknowledged_before_rule_suppression=0 WHERE id=? AND mode=?",
      );
      for (const old of existing) {
        const remainsSuppressed =
          old.status === 'suppressed' &&
          (old.suppression_source === 'manual' || suppressed.has(old.rule_id));
        const type = (JSON.parse(old.input_json) as FindingInput).type;
        if (
          !seen.has(old.id) &&
          old.status !== 'resolved' &&
          !remainsSuppressed &&
          authoritative.has(type)
        )
          resolveFinding.run(timestamp, old.id, mode);
      }
      this.#db
        .prepare(
          'DELETE FROM notifications WHERE mode = ? AND id NOT IN (SELECT id FROM notifications WHERE mode = ? ORDER BY created_at DESC,rowid DESC LIMIT 500)',
        )
        .run(mode, mode);
      this.#db
        .prepare(
          "DELETE FROM findings WHERE mode=? AND status='resolved' AND id NOT IN (SELECT id FROM findings WHERE mode=? AND status='resolved' ORDER BY resolved_at DESC,rowid DESC LIMIT 10000)",
        )
        .run(mode, mode);
    });
  }
  updateFinding(mode: DataMode, id: string, status: FindingStatus): Finding | undefined {
    if (!validStatuses.has(status)) throw new Error('Unsupported finding status.');
    this.#db
      .prepare(
        'UPDATE findings SET status=?,resolved_at=?,suppression_source=?,acknowledged_before_rule_suppression=0 WHERE mode=? AND id=?',
      )
      .run(
        status,
        status === 'resolved' ? now() : null,
        status === 'suppressed' ? 'manual' : null,
        mode,
        id,
      );
    const row = this.#get<FindingRow>('SELECT * FROM findings WHERE mode=? AND id=?', mode, id);
    return row ? findingRecord(row) : undefined;
  }

  settings(mode: DataMode): AppSettings {
    const row = this.#get<{ settings_json: string }>(
      'SELECT settings_json FROM settings WHERE mode=?',
      mode,
    );
    return row
      ? settingsSchema.parse(JSON.parse(row.settings_json))
      : { ...defaultSettings, suppressedRules: [] };
  }
  async querySettings(mode: DataMode): Promise<AppSettings> {
    const rows = await this.#orm
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.mode, mode))
      .limit(1);
    return rows[0]
      ? settingsSchema.parse(rows[0].settings)
      : { ...defaultSettings, suppressedRules: [] };
  }
  saveSettings(mode: DataMode, settings: AppSettings): void {
    const validated = settingsSchema.parse(settings);
    this.#db
      .prepare(
        'INSERT INTO settings(mode,settings_json) VALUES(?,?) ON CONFLICT(mode) DO UPDATE SET settings_json=excluded.settings_json',
      )
      .run(mode, encoded(validated, 64 * 1024));
  }
  audit(mode: DataMode, kind: string, message: string, repository?: string): void {
    this.#transaction(() => {
      this.#db
        .prepare(
          'INSERT INTO audit_events(id,mode,kind,repository,message,created_at) VALUES(?,?,?,?,?,?)',
        )
        .run(
          randomUUID(),
          mode,
          redactStoredText(kind).slice(0, 100),
          repository ?? null,
          redactStoredText(message).slice(0, 2000),
          now(),
        );
      this.#db
        .prepare(
          'DELETE FROM audit_events WHERE mode = ? AND id NOT IN (SELECT id FROM audit_events WHERE mode = ? ORDER BY created_at DESC,rowid DESC LIMIT 2000)',
        )
        .run(mode, mode);
    });
  }
  activity(mode: DataMode): AuditEvent[] {
    return this.#all<{
      id: string;
      mode: DataMode;
      kind: string;
      repository: string | null;
      message: string;
      created_at: string;
    }>(
      'SELECT * FROM audit_events WHERE mode = ? ORDER BY created_at DESC,rowid DESC LIMIT 500',
      mode,
    ).map((row) => ({
      id: row.id,
      mode: row.mode,
      kind: row.kind,
      message: row.message,
      createdAt: row.created_at,
      ...(row.repository ? { repository: row.repository } : {}),
    }));
  }
  notifications(mode: DataMode): Notification[] {
    return this.#all<{
      id: string;
      mode: DataMode;
      finding_id: string;
      title: string;
      is_read: number;
      created_at: string;
    }>(
      'SELECT * FROM notifications WHERE mode = ? ORDER BY created_at DESC,rowid DESC LIMIT 500',
      mode,
    ).map((row) => ({
      id: row.id,
      mode: row.mode,
      findingId: row.finding_id,
      title: row.title,
      read: Boolean(row.is_read),
      createdAt: row.created_at,
    }));
  }
  readNotification(mode: DataMode, id: string): void {
    this.#db.prepare('UPDATE notifications SET is_read=1 WHERE mode=? AND id=?').run(mode, id);
  }
  baseline(mode: DataMode, repository: string): RepositoryConfig | undefined {
    const row = this.#get<{ config_json: string }>(
      'SELECT config_json FROM baselines WHERE mode=? AND repository=?',
      mode,
      repository,
    );
    return row ? (JSON.parse(row.config_json) as RepositoryConfig) : undefined;
  }
  saveBaseline(mode: DataMode, repository: string, config: RepositoryConfig): void {
    this.#transaction(() => {
      this.upsertRepository(mode, repository);
      this.#db
        .prepare(
          'INSERT INTO baselines(mode,repository,config_json,captured_at) VALUES(?,?,?,?) ON CONFLICT(mode,repository) DO UPDATE SET config_json=excluded.config_json,captured_at=excluded.captured_at',
        )
        .run(mode, repository, encoded(config, 512 * 1024), now());
    });
  }
  storageHistory(mode: DataMode): { repository: string; capturedAt: string; bytes: number }[] {
    return this.#all<{ repository: string; captured_at: string; bytes: number }>(
      'SELECT repository,captured_at,bytes FROM storage_history WHERE mode=? ORDER BY captured_at,id LIMIT 5000',
      mode,
    ).map((row) => ({ repository: row.repository, capturedAt: row.captured_at, bytes: row.bytes }));
  }
  retention(days: number, mode?: DataMode): void {
    if (!Number.isInteger(days) || days < 7 || days > 365)
      throw new Error('Retention must be between 7 and 365 days.');
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const scope = mode === undefined ? '' : ' AND mode=?';
    const parameters: SQLInputValue[] = mode === undefined ? [cutoff] : [cutoff, mode];
    this.#transaction(() => {
      for (const table of ['audit_events', 'notifications'] as const)
        this.#db.prepare(`DELETE FROM ${table} WHERE created_at < ?${scope}`).run(...parameters);
      this.#db
        .prepare(`DELETE FROM storage_history WHERE captured_at < ?${scope}`)
        .run(...parameters);
      this.#db
        .prepare(`DELETE FROM findings WHERE status='resolved' AND resolved_at < ?${scope}`)
        .run(...parameters);
      this.#db
        .prepare(
          `DELETE FROM sync_tasks WHERE status IN ('completed','failed','cancelled') AND finished_at < ?${scope}`,
        )
        .run(...parameters);
    });
  }
  async backup(targetPath: string): Promise<void> {
    const target = resolve(targetPath);
    if (target === this.#path || existsSync(target))
      throw new Error('Backup target must be a new file distinct from the active database.');
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    await backup(this.#db, target);
    chmodSync(target, 0o600);
  }

  enqueueTask(mode: DataMode, repository: string): SyncTask {
    return this.#transaction(() => {
      this.upsertRepository(mode, repository);
      const pending = this.#get<TaskRow>(
        "SELECT * FROM sync_tasks WHERE mode=? AND repository=? AND status IN ('queued','running')",
        mode,
        repository,
      );
      if (pending) return taskRecord(pending);
      const id = randomUUID();
      this.#db
        .prepare(
          "INSERT INTO sync_tasks(id,mode,repository,status,attempts,created_at) VALUES(?,?,?,'queued',0,?)",
        )
        .run(id, mode, repository, now());
      this.#db
        .prepare(
          "UPDATE repositories SET sync_status='queued',error=NULL WHERE mode=? AND full_name=?",
        )
        .run(mode, repository);
      return taskRecord(this.#get<TaskRow>('SELECT * FROM sync_tasks WHERE id=?', id)!);
    });
  }
  claimTask(mode: DataMode): SyncTask | undefined {
    return this.#transaction(() => {
      const row = this.#get<TaskRow>(
        "SELECT * FROM sync_tasks WHERE mode=? AND status='queued' ORDER BY created_at,rowid LIMIT 1",
        mode,
      );
      if (!row) return undefined;
      this.#db
        .prepare(
          "UPDATE sync_tasks SET status='running',attempts=attempts+1,started_at=?,error=NULL WHERE id=?",
        )
        .run(now(), row.id);
      this.#db
        .prepare(
          "UPDATE repositories SET sync_status='syncing',error=NULL WHERE mode=? AND full_name=?",
        )
        .run(mode, row.repository);
      return taskRecord(this.#get<TaskRow>('SELECT * FROM sync_tasks WHERE id=?', row.id)!);
    });
  }
  finishTask(id: string, error?: string): void {
    this.#transaction(() => {
      const row = this.#get<TaskRow>(
        "SELECT * FROM sync_tasks WHERE id=? AND status IN ('queued','running')",
        id,
      );
      if (!row) return;
      const message = error ? redactStoredText(error).slice(0, 2000) : null;
      this.#db
        .prepare('UPDATE sync_tasks SET status=?,finished_at=?,error=? WHERE id=?')
        .run(error ? 'failed' : 'completed', now(), message, id);
      this.#db
        .prepare('UPDATE repositories SET sync_status=?,error=? WHERE mode=? AND full_name=?')
        .run(error ? 'error' : 'idle', message, row.mode, row.repository);
    });
  }
  cancelTask(mode: DataMode, id: string): void {
    this.#transaction(() => {
      const task = this.#get<TaskRow>(
        "SELECT * FROM sync_tasks WHERE mode=? AND id=? AND status IN ('queued','running')",
        mode,
        id,
      );
      if (!task) return;
      this.#db
        .prepare("UPDATE sync_tasks SET status='cancelled',finished_at=? WHERE mode=? AND id=?")
        .run(now(), mode, id);
      this.#db
        .prepare(
          "UPDATE repositories SET sync_status='idle',error=NULL WHERE mode=? AND full_name=?",
        )
        .run(mode, task.repository);
    });
  }
  tasks(mode: DataMode): SyncTask[] {
    return this.#all<TaskRow>(
      'SELECT * FROM sync_tasks WHERE mode=? ORDER BY created_at DESC,rowid DESC LIMIT 100',
      mode,
    ).map(taskRecord);
  }
  latestSyncAttemptAt(mode: DataMode, repository: string): string | null {
    return (
      this.#get<{ attempted_at: string }>(
        `SELECT COALESCE(finished_at,started_at,created_at) AS attempted_at FROM sync_tasks
         WHERE mode=? AND repository=? ORDER BY created_at DESC,rowid DESC LIMIT 1`,
        mode,
        repository,
      )?.attempted_at ?? null
    );
  }
  recoverTasks(): number {
    return this.#transaction(() => {
      const result = this.#db
        .prepare(
          "UPDATE sync_tasks SET status='queued',started_at=NULL,error='Interrupted; queued for retry' WHERE status='running'",
        )
        .run();
      this.#db
        .prepare(
          "UPDATE repositories SET sync_status='queued',error=NULL WHERE EXISTS (SELECT 1 FROM sync_tasks WHERE sync_tasks.mode=repositories.mode AND sync_tasks.repository=repositories.full_name AND sync_tasks.status='queued')",
        )
        .run();
      return Number(result.changes);
    });
  }
}
