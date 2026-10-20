import type { DataMode, RepositorySnapshot } from '@gitnostics/shared';
import { authoritativeFindingTypes, diagnose } from '@gitnostics/diagnostics';
import type { Store } from './db';
import { demoSnapshots } from './demo';
import { safeMessage } from './security';

export interface SnapshotClient {
  snapshot(repository: string, signal?: AbortSignal): Promise<RepositorySnapshot>;
}
export class SyncManager {
  private running = new Map<string, AbortController>();
  private closed = false;
  private liveEnabled = true;
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private store: Store,
    private client: SnapshotClient,
  ) {}
  start() {
    this.store.recoverTasks();
    this.pump();
    this.timer = setInterval(() => {
      const interval = this.store.settings('live').syncIntervalMinutes;
      if (interval > 0)
        for (const repository of this.store.repositorySummaries('live')) {
          const lastAttempt = this.store.latestSyncAttemptAt('live', repository.fullName);
          const lastRefresh = Math.max(
            repository.syncedAt ? Date.parse(repository.syncedAt) : 0,
            lastAttempt ? Date.parse(lastAttempt) : 0,
          );
          if (repository.selected && Date.now() - lastRefresh >= interval * 60_000)
            this.queue('live', repository.fullName);
        }
      this.pump();
    }, 60_000);
    this.timer.unref();
  }
  queue(mode: DataMode, repository?: string): number {
    if (this.closed || (mode === 'live' && !this.liveEnabled)) return 0;
    const repositories = this.store
      .repositorySummaries(mode)
      .filter((r) => r.selected && (!repository || r.fullName === repository));
    let count = 0;
    for (const record of repositories) {
      if (record.syncStatus === 'syncing' || record.syncStatus === 'queued') continue;
      this.store.enqueueTask(mode, record.fullName);
      this.store.upsertRepository(mode, record.fullName, { syncStatus: 'queued', error: null });
      count++;
    }
    this.pump();
    return count;
  }
  cancel(mode: DataMode): number {
    let count = 0;
    for (const [key, controller] of this.running)
      if (key.startsWith(`${mode}:`)) {
        controller.abort();
        count++;
      }
    // Claim and close queued work without starting any outbound requests.
    for (;;) {
      const task = this.store.claimTask(mode);
      if (!task) break;
      this.store.cancelTask(mode, task.id);
      this.store.upsertRepository(mode, task.repository, { syncStatus: 'idle', error: null });
      count++;
    }
    this.store.audit(mode, 'sync.cancel', `Cancelled ${count} synchronization tasks.`);
    return count;
  }
  private pump() {
    if (this.closed) return;
    for (const mode of ['live', 'demo'] as const) {
      while (this.running.size < 2) {
        const task = this.store.claimTask(mode);
        if (!task) break;
        if (
          !this.store
            .repositorySummaries(mode)
            .some((repository) => repository.fullName === task.repository && repository.selected)
        ) {
          this.store.cancelTask(mode, task.id);
          continue;
        }
        const controller = new AbortController();
        const key = `${mode}:${task.repository}`;
        this.running.set(key, controller);
        this.store.upsertRepository(mode, task.repository, { syncStatus: 'syncing', error: null });
        void this.run(task.id, mode, task.repository, controller).finally(() => {
          this.running.delete(key);
          this.pump();
        });
      }
    }
  }
  private async run(id: string, mode: DataMode, repository: string, controller: AbortController) {
    try {
      const snapshot =
        mode === 'demo'
          ? demoSnapshots().find((s) => s.fullName === repository)!
          : await this.client.snapshot(repository, controller.signal);
      controller.signal.throwIfAborted();
      if (!snapshot) throw new Error('Demo repository is unavailable. Reset the demo fixtures.');
      if (snapshot.fullName.toLowerCase() !== repository.toLowerCase())
        throw new Error(
          'GitHub snapshot repository identity did not match the requested repository.',
        );
      snapshot.fullName = repository;
      // A removed/deselected repository must not be recreated by a late response.
      if (
        !this.store.repositorySummaries(mode).some((r) => r.fullName === repository && r.selected)
      ) {
        this.store.cancelTask(mode, id);
        return;
      }
      this.store.saveSnapshot(mode, snapshot);
      const settings = this.store.settings(mode);
      const findings = diagnose(snapshot, this.store.baseline(mode, repository), {
        artifactAgeDays: settings.artifactAgeDays,
      });
      this.store.reconcileFindings(
        mode,
        repository,
        findings,
        settings.suppressedRules,
        authoritativeFindingTypes(snapshot),
      );
      this.store.upsertRepository(mode, repository, { syncStatus: 'idle', error: null });
      this.store.finishTask(id);
      this.store.audit(
        mode,
        'sync.complete',
        `${mode === 'demo' ? 'Demo fixtures refreshed' : 'Repository synchronized'}; ${findings.length} diagnostic observations.`,
        repository,
      );
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const message = cancelled ? 'Synchronization cancelled.' : safeMessage(error);
      if (cancelled) this.store.cancelTask(mode, id);
      else this.store.finishTask(id, message);
      if (this.store.repositorySummaries(mode).some((r) => r.fullName === repository))
        this.store.upsertRepository(mode, repository, {
          syncStatus: cancelled ? 'idle' : 'error',
          error: cancelled ? null : message,
        });
      this.store.audit(mode, cancelled ? 'sync.cancelled' : 'sync.error', message, repository);
    }
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const controller of this.running.values()) controller.abort();
    const deadline = Date.now() + 35_000;
    while (this.running.size && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
  }
  disconnect() {
    this.liveEnabled = false;
    this.cancel('live');
  }
}
