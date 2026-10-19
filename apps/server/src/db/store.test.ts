import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings, type FindingInput, type RepositorySnapshot } from '@gitnostics/shared';
import { redactStoredText, Store } from './index.js';
import { migrations } from './migrations.js';

const directories: string[] = [];
const stores: Store[] = [];
function path(name = 'store.sqlite'): string {
  const directory = mkdtempSync(join(tmpdir(), 'gitnostics-db-'));
  directories.push(directory);
  return join(directory, name);
}
function open(file = ':memory:'): Store {
  const store = new Store(file);
  stores.push(store);
  return store;
}
afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      /* A restart test already closed it. */
    }
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function snapshot(): RepositorySnapshot {
  return {
    fullName: 'example/project',
    name: 'project',
    owner: 'example',
    description: 'A repository',
    url: 'https://github.com/example/project',
    private: false,
    defaultBranch: 'main',
    language: 'TypeScript',
    stars: 2,
    openIssues: 1,
    updatedAt: '2026-10-01T00:00:00.000Z',
    permissions: { actions: 'read', administration: 'unknown' },
    pullRequests: [],
    runs: [],
    artifacts: [
      {
        id: 1,
        name: 'report',
        sizeBytes: 123,
        createdAt: '2026-10-01T00:00:00.000Z',
        expiresAt: '2026-12-01T00:00:00.000Z',
        expired: false,
      },
    ],
    config: { values: { defaultBranch: 'main' }, inaccessible: ['protection'] },
    warnings: [],
  };
}
function finding(patch: Partial<FindingInput> = {}): FindingInput {
  return {
    ruleId: 'pr.required-check',
    ruleVersion: 1,
    fingerprint: 'pr:1:test',
    repository: 'example/project',
    type: 'pull_request',
    severity: 'high',
    confidence: 'confirmed',
    title: 'Required check failed',
    explanation: 'The test check failed on the current commit.',
    recommendation: 'Inspect its logs.',
    evidence: [{ label: 'check', value: 'test: failure' }],
    ...patch,
  };
}

describe('SQLite persistence', () => {
  it('redacts JSON credentials, escaped quoted values, PEM fragments and signed URL parameters', () => {
    const json = JSON.stringify({
      password: 'synthetic-secret',
      client_secret: 'synthetic-client-secret',
      safe: 'kept',
    });
    const redacted = redactStoredText(json);
    expect(redacted).not.toContain('synthetic-secret');
    expect(redacted).not.toContain('synthetic-client-secret');
    expect(redacted).toContain('kept');
    const escaped = String.raw`password="synthetic\"embedded secret" client_secret='synthetic\'single quote'`;
    expect(redactStoredText(escaped)).not.toContain('synthetic');
    expect(redactStoredText(escaped)).not.toContain('embedded');
    expect(redactStoredText(escaped)).not.toContain('single quote');
    expect(
      redactStoredText('-----BEGIN RSA PRIVATE KEY-----\nSYNTHETIC-KEY-FRAGMENT'),
    ).not.toContain('SYNTHETIC-KEY');
    const url =
      'https://objects.example/download?X-Amz-Signature=synthetic-signature&X-Amz-Credential=synthetic-credential&file=report';
    expect(redactStoredText(url)).not.toContain('synthetic-');
    expect(redactStoredText(url)).toContain('file=report');
    const store = open();
    store.audit('live', 'error', json);
    expect(store.activity('live')[0]?.message).not.toContain('synthetic-');
  });

  it('redacts complete legacy Authorization header values and JSON authorization assignments', () => {
    for (const input of [
      'Authorization: token synthetic-legacy-value',
      'Proxy-Authorization: Custom synthetic-proxy-value',
      JSON.stringify({ authorization: 'token synthetic-json-value', safe: 'kept' }),
    ]) {
      expect(redactStoredText(input)).not.toContain('synthetic-');
      const store = open();
      store.audit('live', 'error', input);
      expect(store.activity('live')[0]?.message).not.toContain('synthetic-');
    }
    expect(
      redactStoredText('Authorization: token synthetic-value\nError: connection refused'),
    ).toContain('Error: connection refused');
  });
  it('persists preferences, snapshots and baselines across restart with real typed Drizzle queries', async () => {
    const file = path();
    const first = open(file);
    first.saveSnapshot('live', snapshot());
    first.upsertRepository('live', 'example/project', { favorite: true });
    first.saveSettings('live', { ...defaultSettings, theme: 'light' });
    first.saveBaseline('live', 'example/project', snapshot().config);
    first.close();
    const second = open(file);
    expect(await second.querySettings('live')).toMatchObject({ theme: 'light' });
    expect(await second.queryRepositories('live')).toMatchObject([
      { fullName: 'example/project', favorite: true, snapshot: { stars: 2 } },
    ]);
    expect(second.repositories('live')[0]?.snapshot?.artifacts[0]?.sizeBytes).toBe(123);
    expect(second.baseline('live', 'example/project')).toEqual(snapshot().config);
    expect(second.storageHistory('live')).toMatchObject([
      { repository: 'example/project', bytes: 123 },
    ]);
  });

  it('applies only unapplied migration versions and upgrades a version-one database', () => {
    const file = path();
    const db = new DatabaseSync(file);
    db.exec(
      'CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)',
    );
    db.exec(migrations[0].sql);
    db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(
      1,
      migrations[0].name,
      '2026-01-01T00:00:00Z',
    );
    db.prepare('INSERT INTO repositories(mode,full_name) VALUES(?,?)').run(
      'live',
      'example/legacy',
    );
    db.close();
    const store = open(file);
    expect(store.repositories('live')[0]?.fullName).toBe('example/legacy');
    expect(store.enqueueTask('live', 'example/legacy').status).toBe('queued');
    store.close();
    open(file);
    const inspected = new DatabaseSync(file);
    expect(inspected.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()?.count).toBe(
      3,
    );
    inspected.close();
  });

  it('refuses a schema created by a newer application', () => {
    const file = path();
    const db = new DatabaseSync(file);
    db.exec(
      'CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)',
    );
    db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(999, 'future', '2026-01-01');
    db.close();
    expect(() => open(file)).toThrow('Database schema is newer');
  });

  it('isolates every category of demo and live data', async () => {
    const store = open();
    store.saveSnapshot('demo', snapshot());
    store.reconcileFindings('demo', 'example/project', [finding()]);
    store.audit('demo', 'sync', 'Demo synchronized');
    store.saveSettings('demo', { ...defaultSettings, theme: 'light' });
    store.saveBaseline('demo', 'example/project', snapshot().config);
    store.enqueueTask('demo', 'example/project');
    expect(store.repositories('live')).toEqual([]);
    expect(await store.queryRepositories('live')).toEqual([]);
    expect(store.findings('live')).toEqual([]);
    expect(store.notifications('live')).toEqual([]);
    expect(store.activity('live')).toEqual([]);
    expect(store.storageHistory('live')).toEqual([]);
    expect(store.baseline('live', 'example/project')).toBeUndefined();
    expect(store.tasks('live')).toEqual([]);
    expect(store.settings('live').theme).toBe('dark');
    expect(await store.querySettings('live')).toEqual(defaultSettings);
    store.reconcileFindings('live', 'example/project', [finding()]);
    const liveId = store.findings('live')[0]!.id;
    const demoId = store.findings('demo')[0]!.id;
    expect(liveId).not.toBe(demoId);
    expect(store.updateFinding('live', demoId, 'acknowledged')).toBeUndefined();
    store.removeRepository('live', 'example/project');
    expect(store.findings('demo')).toHaveLength(1);
  });

  it('deduplicates finding identity, preserves acknowledgment, resolves and reopens without alert spam', () => {
    const store = open();
    store.reconcileFindings('live', 'example/project', [finding(), finding()]);
    const initial = store.findings('live')[0]!;
    expect(initial.status).toBe('new');
    expect(store.notifications('live')).toHaveLength(1);
    store.reconcileFindings('live', 'example/project', [finding({ ruleVersion: 2 })]);
    expect(store.findings('live')).toMatchObject([
      { id: initial.id, status: 'active', ruleVersion: 2 },
    ]);
    store.updateFinding('live', initial.id, 'acknowledged');
    store.reconcileFindings('live', 'example/project', [finding()]);
    expect(store.findings('live')[0]?.status).toBe('acknowledged');
    expect(store.notifications('live')).toHaveLength(1);
    store.reconcileFindings('live', 'example/project', []);
    expect(store.findings('live')[0]).toMatchObject({ id: initial.id, status: 'resolved' });
    expect(store.findings('live')[0]?.resolvedAt).toBeTruthy();
    store.reconcileFindings('live', 'example/project', [finding()]);
    expect(store.findings('live')[0]).toMatchObject({
      id: initial.id,
      status: 'active',
      firstDetectedAt: initial.firstDetectedAt,
    });
    expect(store.findings('live')[0]?.resolvedAt).toBeUndefined();
    expect(store.notifications('live')).toHaveLength(2);
  });

  it('preserves suppressed findings and respects notification severity and preference settings', () => {
    const store = open();
    store.saveSettings('live', {
      ...defaultSettings,
      minimumSeverity: 'critical',
      suppressedRules: ['pr.required-check'],
    });
    store.reconcileFindings('live', 'example/project', [finding()]);
    const id = store.findings('live')[0]!.id;
    expect(store.findings('live')[0]?.status).toBe('suppressed');
    store.reconcileFindings('live', 'example/project', []);
    store.reconcileFindings('live', 'example/project', [finding()]);
    expect(store.findings('live')[0]).toMatchObject({ id, status: 'suppressed' });
    expect(store.notifications('live')).toEqual([]);
    store.reconcileFindings('live', 'example/project', [finding({ ruleId: 'another' })]);
    expect(store.notifications('live')).toEqual([]);
    store.saveSettings('live', { ...defaultSettings, notificationsEnabled: false });
    store.reconcileFindings('live', 'example/project', [
      finding({ ruleId: 'critical', severity: 'critical' }),
    ]);
    expect(store.notifications('live')).toEqual([]);
  });

  it('revives rule-suppressed findings after unsuppression while retaining manual suppression', () => {
    const store = open();
    const manual = finding({ fingerprint: 'manual' });
    store.reconcileFindings('live', 'example/project', [finding(), manual]);
    const original = store
      .findings('live')
      .find((row) => row.fingerprint === finding().fingerprint)!;
    const manuallySuppressed = store.findings('live').find((row) => row.fingerprint === 'manual')!;
    store.updateFinding('live', manuallySuppressed.id, 'suppressed');
    store.saveSettings('live', { ...defaultSettings, suppressedRules: [finding().ruleId] });
    store.reconcileFindings('live', 'example/project', [finding(), manual]);
    expect(store.findings('live').every((row) => row.status === 'suppressed')).toBe(true);
    store.saveSettings('live', defaultSettings);
    store.reconcileFindings('live', 'example/project', [finding(), manual]);
    expect(store.findings('live').find((row) => row.id === original.id)?.status).toBe('active');
    expect(store.findings('live').find((row) => row.id === manuallySuppressed.id)?.status).toBe(
      'suppressed',
    );
    store.reconcileFindings('live', 'example/project', []);
    expect(store.findings('live').find((row) => row.id === original.id)?.status).toBe('resolved');
    expect(store.findings('live').find((row) => row.id === manuallySuppressed.id)?.status).toBe(
      'suppressed',
    );
  });

  it('does not resolve missing findings from nonauthoritative collections or record unknown storage as zero', () => {
    const store = open();
    store.saveSnapshot('live', snapshot());
    store.reconcileFindings('live', 'example/project', [
      finding(),
      finding({ type: 'storage', fingerprint: 'artifact:1' }),
    ]);
    store.reconcileFindings('live', 'example/project', [], [], ['storage']);
    expect(store.findings('live').find((row) => row.type === 'storage')?.status).toBe('resolved');
    expect(store.findings('live').find((row) => row.type === 'pull_request')?.status).toBe('new');
    const unavailable = snapshot();
    unavailable.artifacts = [];
    unavailable.collectionState = {
      artifacts: false,
      pullRequests: true,
      runs: true,
      config: true,
    };
    store.saveSnapshot('live', unavailable);
    expect(store.storageHistory('live')).toMatchObject([{ bytes: 123 }]);
    store.reconcileFindings('live', 'example/project', []);
    expect(store.findings('live').every((row) => row.status === 'resolved')).toBe(true);
  });

  it('caps resolved history while preserving current unresolved findings', () => {
    const file = path();
    const store = open(file);
    store.reconcileFindings('live', 'example/project', [finding()]);
    const raw = new DatabaseSync(file);
    const insert =
      raw.prepare(`INSERT INTO findings(id,mode,repository,rule_id,fingerprint,status,first_detected_at,last_observed_at,resolved_at,input_json)
      VALUES(?,'live','example/project','history',?,'resolved','2026-01-01','2026-01-01','2026-01-01',?)`);
    raw.exec('BEGIN');
    for (let i = 0; i < 10_005; i++)
      insert.run(
        `history-${i}`,
        `history-${i}`,
        JSON.stringify(finding({ fingerprint: `history-${i}` })),
      );
    raw.exec('COMMIT');
    store.reconcileFindings('live', 'example/project', [finding()]);
    expect(
      raw.prepare("SELECT COUNT(*) AS count FROM findings WHERE status='resolved'").get()?.count,
    ).toBe(10_000);
    expect(
      store.findings('live').find((row) => row.fingerprint === finding().fingerprint)?.status,
    ).toBe('active');
    raw.close();
  });

  it('uses bound values and redacts secrets before storage and backup', async () => {
    const file = path();
    const store = open(file);
    const malicious = "'); DROP TABLE repositories; --";
    store.reconcileFindings('live', 'example/project', [finding({ title: malicious })]);
    expect(store.findings('live')[0]?.title).toBe(malicious);
    expect(store.repositories('live')).toHaveLength(1);
    expect(() => store.upsertRepository('live', "example/repo';DROP TABLE findings;--")).toThrow();
    const secret = `ghp_${'x'.repeat(36)}`;
    store.audit('live', 'error', `Credential ${secret}, authorization=Bearer ${'a'.repeat(32)}`);
    expect(store.activity('live')[0]?.message).not.toContain(secret);
    expect(store.activity('live')[0]?.message).not.toContain('a'.repeat(32));
    const backupFile = join(directories[0]!, 'backup.sqlite');
    await store.backup(backupFile);
    expect(readFileSync(backupFile).includes(Buffer.from(secret))).toBe(false);
    const restored = open(backupFile);
    expect(restored.findings('live')[0]?.title).toBe(malicious);
    await expect(store.backup(file)).rejects.toThrow('Backup target');
    await expect(store.backup(backupFile)).rejects.toThrow('Backup target');
  });

  it('atomically saves snapshot/history and rejects cross-repository findings', () => {
    const store = open();
    store.saveSnapshot('live', snapshot());
    const invalid = snapshot();
    invalid.stars = 999;
    invalid.artifacts[0]!.sizeBytes = Number.NaN;
    expect(() => store.saveSnapshot('live', invalid)).toThrow('Invalid artifact');
    expect(store.repositories('live')[0]?.snapshot?.stars).toBe(2);
    expect(store.storageHistory('live')).toHaveLength(1);
    expect(() =>
      store.reconcileFindings('live', 'example/project', [
        finding({ repository: 'other/repository' }),
      ]),
    ).toThrow('does not belong');
    expect(store.findings('live')).toEqual([]);
    const huge = finding({
      fingerprint: 'huge',
      evidence: Array.from({ length: 20 }, () => ({ label: 'large', value: 'x'.repeat(70_000) })),
    });
    expect(() => store.reconcileFindings('live', 'example/project', [finding(), huge])).toThrow(
      'bounded size',
    );
    expect(store.findings('live')).toEqual([]);
    expect(store.notifications('live')).toEqual([]);
  });

  it('queues durable tasks once, recovers interruptions and isolates claims', () => {
    const file = path();
    const first = open(file);
    const task = first.enqueueTask('live', 'example/project');
    expect(first.enqueueTask('live', 'example/project').id).toBe(task.id);
    expect(first.claimTask('demo')).toBeUndefined();
    expect(first.claimTask('live')).toMatchObject({ id: task.id, status: 'running', attempts: 1 });
    expect(first.claimTask('live')).toBeUndefined();
    first.close();
    const second = open(file);
    expect(second.repositories('live')[0]?.syncStatus).toBe('queued');
    expect(second.claimTask('live')).toMatchObject({ id: task.id, attempts: 2 });
    second.finishTask(task.id, 'API permission denied');
    expect(second.tasks('live')[0]).toMatchObject({
      status: 'failed',
      error: 'API permission denied',
    });
    expect(second.repositories('live')[0]?.syncStatus).toBe('error');
    const next = second.enqueueTask('live', 'example/project');
    expect(next.id).not.toBe(task.id);
    second.claimTask('live');
    second.finishTask(next.id);
    expect(second.repositories('live')[0]?.syncStatus).toBe('idle');
    expect(second.tasks('live')[0]?.status).toBe('completed');
  });

  it('bounds current log excerpts, audit history and notification history', () => {
    const store = open();
    const sample = snapshot();
    sample.runs.push({
      id: 1,
      workflowId: 1,
      name: 'CI',
      title: 'CI',
      branch: 'main',
      event: 'push',
      status: 'completed',
      conclusion: 'failure',
      url: 'https://github.com/example/project/actions/runs/1',
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
      durationSeconds: 10,
      attempt: 1,
      jobs: [
        {
          id: 1,
          name: 'test',
          conclusion: 'failure',
          url: 'https://github.com/example/project/actions/runs/1',
          logExcerpt: 'x'.repeat(70_000),
        },
      ],
    });
    store.saveSnapshot('live', sample);
    expect(store.repositories('live')[0]?.snapshot?.runs[0]?.jobs[0]?.logExcerpt?.length).toBe(
      16_384,
    );
    for (let i = 0; i < 2005; i++) store.audit('live', 'sync', `Event ${i}`);
    expect(store.activity('live')).toHaveLength(500);
    store.reconcileFindings(
      'live',
      'example/project',
      Array.from({ length: 510 }, (_, i) => finding({ fingerprint: `pr:${i}` })),
    );
    expect(store.notifications('live')).toHaveLength(500);
  });

  it('deletes repository-dependent rows without deleting the other mode', () => {
    const store = open();
    for (const mode of ['live', 'demo'] as const) {
      store.saveSnapshot(mode, snapshot());
      store.reconcileFindings(mode, 'example/project', [finding()]);
      store.saveBaseline(mode, 'example/project', snapshot().config);
      store.enqueueTask(mode, 'example/project');
    }
    store.removeRepository('live', 'example/project');
    expect(store.findings('live')).toEqual([]);
    expect(store.notifications('live')).toEqual([]);
    expect(store.baseline('live', 'example/project')).toBeUndefined();
    expect(store.storageHistory('live')).toEqual([]);
    expect(store.tasks('live')).toEqual([]);
    expect(store.repositories('demo')).toHaveLength(1);
    expect(store.findings('demo')).toHaveLength(1);
  });

  it('retains active problems while pruning old resolved/history data', () => {
    const file = path();
    const store = open(file);
    store.reconcileFindings('live', 'example/project', [
      finding(),
      finding({ fingerprint: 'active' }),
    ]);
    store.updateFinding(
      'live',
      store.findings('live').find((row) => row.fingerprint === 'pr:1:test')!.id,
      'resolved',
    );
    store.saveSnapshot('live', snapshot());
    store.audit('live', 'sync', 'old');
    const raw = new DatabaseSync(file);
    raw.exec(
      "UPDATE audit_events SET created_at='2020-01-01'; UPDATE storage_history SET captured_at='2020-01-01'; UPDATE findings SET resolved_at='2020-01-01' WHERE status='resolved'; UPDATE notifications SET created_at='2020-01-01'",
    );
    raw.close();
    store.retention(90);
    expect(store.findings('live')).toHaveLength(1);
    expect(store.findings('live')[0]?.fingerprint).toBe('active');
    expect(store.activity('live')).toEqual([]);
    expect(store.storageHistory('live')).toEqual([]);
    expect(store.notifications('live')).toEqual([]);
    expect(() => store.retention(0)).toThrow('Retention');
  });

  it('honors different demo and live retention policies without deleting the other mode', () => {
    const file = path();
    const store = open(file);
    for (const mode of ['live', 'demo'] as const) {
      store.audit(mode, 'sync', 'old');
      store.saveSnapshot(mode, snapshot());
      store.reconcileFindings(mode, 'example/project', [finding()]);
      store.updateFinding(mode, store.findings(mode)[0]!.id, 'resolved');
      const task = store.enqueueTask(mode, 'example/project');
      store.finishTask(task.id);
    }
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const raw = new DatabaseSync(file);
    for (const [table, column] of [
      ['audit_events', 'created_at'],
      ['notifications', 'created_at'],
      ['storage_history', 'captured_at'],
      ['findings', 'resolved_at'],
      ['sync_tasks', 'finished_at'],
    ])
      raw.prepare(`UPDATE ${table} SET ${column}=?`).run(old);
    raw.close();
    store.retention(7, 'live');
    store.retention(90, 'demo');
    expect(store.activity('live')).toEqual([]);
    expect(store.notifications('live')).toEqual([]);
    expect(store.storageHistory('live')).toEqual([]);
    expect(store.findings('live')).toEqual([]);
    expect(store.tasks('live')).toEqual([]);
    expect(store.activity('demo')).toHaveLength(1);
    expect(store.notifications('demo')).toHaveLength(1);
    expect(store.storageHistory('demo')).toHaveLength(1);
    expect(store.findings('demo')).toHaveLength(1);
    expect(store.tasks('demo')).toHaveLength(1);
  });
});
