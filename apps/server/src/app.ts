import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  actionRequestSchema,
  modeSchema,
  repoNameSchema,
  settingsSchema,
  type ActionPreview,
  type ActionRequest,
  type ConnectionStatus,
  type Dashboard,
  type DataMode,
  type RepositoryDiscovery,
} from '@gitnostics/shared';
import {
  authoritativeFindingTypes,
  correlateFailures,
  diagnose,
  workflowAnalytics,
} from '@gitnostics/diagnostics';
import { GitHubClient } from '@gitnostics/github';
import { Store } from './db';
import { readConfig, type Config } from './config';
import { apiRoutePath, installSecurity, safeMessage } from './security';
import { SyncManager, type SnapshotClient } from './sync';
import { demoSnapshots } from './demo';
import { Backups } from './backups';

export interface GitHubService extends SnapshotClient {
  getConnectionStatus(): ConnectionStatus;
  discoverRepositories(signal?: AbortSignal): Promise<RepositoryDiscovery>;
  execute(request: ActionRequest, signal?: AbortSignal): Promise<void>;
  disconnect(): void;
}
export async function createApp(
  options: {
    config?: Config;
    store?: Store;
    github?: GitHubService;
    background?: boolean;
    logger?: boolean;
  } = {},
) {
  const config = options.config ?? readConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const store = options.store ?? new Store(resolve(config.dataDir, 'gitnostics.sqlite'));
  const github = options.github ?? new GitHubClient(config.github);
  const sync = new SyncManager(store, github);
  const backups = new Backups(store, config.dataDir);
  const app = Fastify({
    bodyLimit: 65_536,
    requestTimeout: 30_000,
    logger: options.logger
      ? {
          level: 'info',
          redact: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers.x-csrf-token',
            'res.headers.set-cookie',
          ],
          serializers: {
            req: (request) => ({ method: request.method, url: request.url?.split('?')[0] }),
          },
        }
      : false,
  });
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: config.publicOrigin.startsWith('https:') ? [] : null,
      },
    },
  });
  await app.register(rateLimit, { max: 240, timeWindow: '1 minute' });
  installSecurity(app, config);
  app.addHook('onSend', async (request, reply) => {
    if (apiRoutePath(request)) reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')
          .slice(0, 500),
      });
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500)
      return reply.code(statusCode).send({ error: safeMessage(error) });
    return reply.code(500).send({
      error: 'The operation failed. Review Activity for recorded synchronization or action errors.',
    });
  });
  const modeOf = (query: unknown): DataMode =>
    modeSchema.parse((query as { mode?: unknown })?.mode ?? 'live');
  const nameOf = (params: unknown) => {
    const p = params as { owner: string; repo: string };
    return repoNameSchema.parse(`${p.owner}/${p.repo}`);
  };
  const requireRepo = (mode: DataMode, repository: string) => {
    const record = store.repositories(mode).find((r) => r.fullName === repository);
    if (!record)
      throw Object.assign(new Error('Repository is not monitored in this data mode.'), {
        statusCode: 404,
      });
    return record;
  };
  app.get('/api/health', async () => ({ status: 'ok', version: '0.1.0', database: 'ready' }));
  app.get('/api/dashboard', async (request) => {
    const mode = modeOf(request.query);
    const repositories = await store.queryRepositories(mode);
    const incidents = repositories.flatMap((r) =>
      r.snapshot
        ? correlateFailures(r.snapshot.runs).map((i) => ({
            ...i,
            fingerprint: `${r.fullName}:${i.fingerprint}`,
          }))
        : [],
    );
    return {
      mode,
      repositories,
      findings: store.findings(mode),
      activity: store.activity(mode),
      incidents,
      notifications: store.notifications(mode),
      settings: await store.querySettings(mode),
      connection:
        mode === 'demo'
          ? {
              mode: 'public',
              connected: true,
              identity: 'Fictional local fixtures',
              writesEnabled: true,
            }
          : github.getConnectionStatus(),
      storageHistory: store.storageHistory(mode),
      workflowAnalytics: repositories.flatMap((repository) =>
        workflowAnalytics(repository.snapshot?.runs ?? []).map((workflow) => ({
          ...workflow,
          repository: repository.fullName,
        })),
      ),
    } satisfies Dashboard;
  });
  app.get('/api/settings', async (request) => store.querySettings(modeOf(request.query)));
  app.put('/api/settings', async (request) => {
    const mode = modeOf(request.query);
    const settings = settingsSchema.parse(request.body);
    store.saveSettings(mode, settings);
    for (const repository of store.repositories(mode))
      if (repository.snapshot)
        store.reconcileFindings(
          mode,
          repository.fullName,
          diagnose(repository.snapshot, store.baseline(mode, repository.fullName), {
            artifactAgeDays: settings.artifactAgeDays,
          }),
          settings.suppressedRules,
          authoritativeFindingTypes(repository.snapshot),
        );
    store.audit(mode, 'settings.update', 'Application preferences updated.');
    return settings;
  });
  app.post('/api/demo/reset', async () => {
    if (store.repositories('demo').some((r) => ['queued', 'syncing'].includes(r.syncStatus)))
      throw Object.assign(new Error('Cancel demo synchronization before resetting fixtures.'), {
        statusCode: 409,
      });
    for (const repository of store.repositories('demo'))
      store.removeRepository('demo', repository.fullName);
    for (const snapshot of demoSnapshots()) {
      store.upsertRepository('demo', snapshot.fullName, {
        selected: true,
        favorite: snapshot.name === 'api',
      });
      store.saveSnapshot('demo', snapshot);
      if (snapshot.name === 'api')
        store.saveBaseline('demo', snapshot.fullName, {
          values: { ...snapshot.config.values, requiredApprovals: 2 },
          inaccessible: [],
        });
      const settings = store.settings('demo');
      store.reconcileFindings(
        'demo',
        snapshot.fullName,
        diagnose(snapshot, store.baseline('demo', snapshot.fullName), {
          artifactAgeDays: settings.artifactAgeDays,
        }),
        settings.suppressedRules,
      );
    }
    store.audit(
      'demo',
      'demo.reset',
      'Loaded fictional local fixtures. Demo operations never contact GitHub.',
    );
    return { ok: true };
  });
  app.post('/api/repositories', async (request, reply) => {
    const mode = modeOf(request.query);
    if (mode === 'demo')
      return reply.code(400).send({
        error:
          'Demo repositories are fixed local fixtures. Switch to connected mode to add a repository.',
      });
    const { fullName } = z.object({ fullName: repoNameSchema }).strict().parse(request.body);
    if (disconnected)
      return reply
        .code(409)
        .send({ error: 'Connection disconnected. Restart after configuring access.' });
    if (
      store.repositories(mode).length >= 100 &&
      !store.repositories(mode).some((r) => r.fullName === fullName)
    )
      return reply
        .code(400)
        .send({ error: 'This deployment supports up to 100 monitored repositories.' });
    store.upsertRepository(mode, fullName, { selected: true });
    store.audit(mode, 'repository.add', 'Repository selected for synchronization.', fullName);
    return { queued: sync.queue(mode, fullName) };
  });
  app.patch('/api/repositories/:owner/:repo', async (request) => {
    const mode = modeOf(request.query),
      name = nameOf(request.params);
    requireRepo(mode, name);
    const patch = z
      .object({ favorite: z.boolean().optional(), selected: z.boolean().optional() })
      .strict()
      .parse(request.body);
    store.upsertRepository(mode, name, patch);
    return { ok: true };
  });
  app.delete('/api/repositories/:owner/:repo', async (request, reply) => {
    const mode = modeOf(request.query),
      name = nameOf(request.params);
    const record = requireRepo(mode, name);
    if (['syncing', 'queued'].includes(record.syncStatus))
      return reply
        .code(409)
        .send({ error: 'Cancel synchronization before removing this repository.' });
    store.removeRepository(mode, name);
    store.audit(
      mode,
      'repository.remove',
      'Removed local repository data. The GitHub repository was not modified.',
      name,
    );
    return { ok: true };
  });
  app.post('/api/sync', async (request) => {
    const mode = modeOf(request.query);
    if (mode === 'live' && disconnected)
      throw Object.assign(new Error('Connection disconnected. Restart after configuring access.'), {
        statusCode: 409,
      });
    const body = z
      .object({ repository: repoNameSchema.optional() })
      .strict()
      .parse(request.body ?? {});
    if (body.repository && !requireRepo(mode, body.repository).selected)
      throw Object.assign(new Error('Enable monitoring before synchronizing this repository.'), {
        statusCode: 409,
      });
    return { queued: sync.queue(mode, body.repository) };
  });
  app.post('/api/sync/cancel', async (request) => ({
    cancelled: sync.cancel(modeOf(request.query)),
  }));
  app.patch('/api/findings/:id', async (request, reply) => {
    const { status } = z
      .object({ status: z.enum(['acknowledged', 'suppressed', 'active']) })
      .strict()
      .parse(request.body);
    const { id } = z.object({ id: z.string().max(100) }).parse(request.params);
    const mode = modeOf(request.query);
    const finding = store.updateFinding(mode, id, status);
    if (!finding) return reply.code(404).send({ error: 'Finding not found in this data mode.' });
    store.audit(mode, 'finding.update', `Finding ${status}: ${finding.title}`, finding.repository);
    return finding;
  });
  app.post('/api/baselines', async (request, reply) => {
    const { repository } = z.object({ repository: repoNameSchema }).strict().parse(request.body);
    const mode = modeOf(request.query),
      record = requireRepo(mode, repository);
    if (!record.snapshot)
      return reply
        .code(409)
        .send({ error: 'Synchronize the repository before saving a baseline.' });
    store.saveBaseline(mode, repository, record.snapshot.config);
    const settings = store.settings(mode);
    store.reconcileFindings(
      mode,
      repository,
      diagnose(record.snapshot, record.snapshot.config, {
        artifactAgeDays: settings.artifactAgeDays,
      }),
      settings.suppressedRules,
      authoritativeFindingTypes(record.snapshot),
    );
    store.audit(
      mode,
      'baseline.save',
      'Saved accessible current configuration as the expected baseline.',
      repository,
    );
    return { ok: true };
  });
  app.post('/api/notifications/:id/read', async (request) => {
    const { id } = z.object({ id: z.string().max(100) }).parse(request.params);
    store.readNotification(modeOf(request.query), id);
    return { ok: true };
  });
  let disconnected = false;
  app.get('/api/connection/discovery', async (_request, reply) => {
    if (disconnected)
      return reply
        .code(409)
        .send({ error: 'Connection disconnected. Restart after configuring access.' });
    try {
      return await github.discoverRepositories(AbortSignal.timeout(30_000));
    } catch (error) {
      return reply.code(502).send({ error: safeMessage(error) });
    }
  });
  app.post('/api/connection/disconnect', async () => {
    sync.disconnect();
    github.disconnect();
    delete config.github.token;
    delete config.github.privateKey;
    disconnected = true;
    previews.clear();
    previewSnapshots.clear();
    store.audit(
      'live',
      'connection.disconnect',
      'Disconnected client credentials and cached tokens. Remove environment configuration before restart to keep disconnected.',
    );
    return {
      ok: true,
      message:
        'Client credentials and cached tokens cleared. Remove environment variables and private-key configuration before restart to keep disconnected.',
    };
  });
  app.post('/api/backup', async () => {
    const filename = await backups.create();
    return {
      filename,
      message:
        'Saved under DATA_DIR/backups. Backups contain private repository metadata; protect this directory.',
    };
  });
  const previews = new Map<string, ActionPreview>();
  const previewSnapshots = new Map<string, string>();
  const executing = new Set<string>();
  app.post('/api/actions/preview', async (request) => {
    const mode = modeOf(request.query),
      action = actionRequestSchema.parse(request.body);
    const record = requireRepo(mode, action.repository),
      snapshot = record.snapshot;
    if (!snapshot || !record.selected)
      throw Object.assign(new Error('Select and synchronize before preparing an action.'), {
        statusCode: 409,
      });
    const impact: string[] = [];
    let title: string;
    if (action.kind === 'delete_artifacts') {
      if (
        !action.artifactIds?.length ||
        new Set(action.artifactIds).size !== action.artifactIds.length
      )
        throw Object.assign(new Error('Select distinct artifact IDs.'), { statusCode: 400 });
      const artifacts = action.artifactIds.map((id) => snapshot.artifacts.find((a) => a.id === id));
      if (artifacts.some((a) => !a))
        throw Object.assign(new Error('An artifact is absent from the synchronized repository.'), {
          statusCode: 400,
        });
      title = `Delete ${artifacts.length} artifact${artifacts.length === 1 ? '' : 's'}`;
      impact.push(...artifacts.map((a) => `${a!.name} · ${a!.sizeBytes} bytes · ID ${a!.id}`));
      impact.push(
        'Deletion is permanent. GitHub storage measurements and billing may update later.',
      );
    } else if (action.kind === 'dispatch') {
      if (
        !action.workflowId ||
        !snapshot.runs.some((r) => r.workflowId === action.workflowId) ||
        !action.ref ||
        ![snapshot.defaultBranch, ...snapshot.runs.map((r) => r.branch)].includes(action.ref)
      )
        throw Object.assign(
          new Error('Select a known workflow and branch from synchronized runs.'),
          { statusCode: 400 },
        );
      title = 'Dispatch workflow';
      impact.push(
        `Workflow ${action.workflowId} on ${action.ref}; workflow_dispatch must be enabled in GitHub. This can run repository workflow code and consume Actions minutes.`,
      );
    } else {
      const run = snapshot.runs.find((r) => r.id === action.runId);
      if (
        !run ||
        run.status !== 'completed' ||
        (action.kind === 'rerun_failed' &&
          !['failure', 'timed_out', 'cancelled'].includes(run.conclusion ?? ''))
      )
        throw Object.assign(
          new Error('Select a completed run eligible for this rerun operation.'),
          { statusCode: 400 },
        );
      title = action.kind === 'rerun_failed' ? 'Rerun failed jobs' : 'Rerun workflow';
      impact.push(
        `${run.name} · run ${run.id} · ${run.branch}; this can run repository workflow code and consume Actions minutes.`,
      );
    }
    const connection = github.getConnectionStatus();
    let reason = !config.writesEnabled
      ? 'GitHub writes are disabled. Configure WRITE_ENABLED=true and AUTH_TOKEN to opt in.'
      : disconnected || !connection.connected
        ? 'Connect a GitHub App before executing actions.'
        : snapshot.permissions.actions !== 'write' || !connection.writesEnabled
          ? 'The GitHub App installation must have Actions write permission.'
          : !record.syncedAt || Date.now() - Date.parse(record.syncedAt) > 15 * 60_000
            ? 'Refresh this repository; action previews require data less than 15 minutes old.'
            : undefined;
    if (mode === 'demo') {
      reason = undefined;
      impact.unshift('DEMO SIMULATION: no request will be sent to GitHub.');
    }
    for (const [id, value] of previews)
      if (Date.parse(value.expiresAt) < Date.now()) {
        previews.delete(id);
        previewSnapshots.delete(id);
      }
    if (previews.size >= 500)
      throw Object.assign(
        new Error('Too many pending previews. Wait for older previews to expire.'),
        { statusCode: 429 },
      );
    const preview: ActionPreview = {
      id: randomUUID(),
      mode,
      request: action,
      title,
      impact,
      destructive: action.kind === 'delete_artifacts',
      allowed: !reason,
      reason,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      confirmation:
        mode === 'demo'
          ? 'SIMULATE'
          : action.kind === 'delete_artifacts'
            ? `DELETE ${action.artifactIds!.length} ARTIFACTS`
            : 'EXECUTE',
    };
    previews.set(preview.id, preview);
    previewSnapshots.set(preview.id, record.syncedAt ?? '');
    return preview;
  });
  app.post('/api/actions/execute', async (request, reply) => {
    const mode = modeOf(request.query);
    const body = z
      .object({ previewId: z.uuid(), confirmation: z.string().max(100) })
      .strict()
      .parse(request.body);
    const preview = previews.get(body.previewId);
    if (!preview || preview.mode !== mode || Date.parse(preview.expiresAt) < Date.now())
      return reply
        .code(409)
        .send({ error: 'Preview expired or belongs to another data mode. Prepare a new preview.' });
    if (body.confirmation !== preview.confirmation)
      return reply.code(400).send({ error: `Type ${preview.confirmation} to confirm.` });
    if (!preview.allowed) return reply.code(403).send({ error: preview.reason });
    const currentRecord = requireRepo(mode, preview.request.repository);
    const currentSnapshot = currentRecord.snapshot;
    if (
      !currentRecord.selected ||
      !currentSnapshot ||
      currentRecord.syncedAt !== previewSnapshots.get(preview.id)
    )
      return reply.code(409).send({ error: 'Repository data changed. Prepare a new preview.' });
    if (
      mode === 'live' &&
      (!currentRecord.syncedAt ||
        Date.now() - Date.parse(currentRecord.syncedAt) > 15 * 60_000 ||
        currentSnapshot.permissions.actions !== 'write')
    )
      return reply.code(403).send({
        error:
          'Refresh the repository and verify Actions write permission before preparing a new preview.',
      });
    const action = preview.request;
    if (
      action.kind === 'delete_artifacts' &&
      !action.artifactIds?.every((id) => currentSnapshot.artifacts.some((a) => a.id === id))
    )
      return reply.code(409).send({ error: 'Artifact selection changed. Prepare a new preview.' });
    if (
      (action.kind === 'rerun' || action.kind === 'rerun_failed') &&
      !currentSnapshot.runs.some((r) => r.id === action.runId && r.status === 'completed')
    )
      return reply.code(409).send({ error: 'Workflow run changed. Prepare a new preview.' });
    if (
      action.kind === 'dispatch' &&
      !currentSnapshot.runs.some((r) => r.workflowId === action.workflowId)
    )
      return reply.code(409).send({ error: 'Workflow changed. Prepare a new preview.' });
    const key = `${mode}:${preview.request.repository}`;
    if (executing.has(key))
      return reply.code(409).send({ error: 'Another action is running for this repository.' });
    if (
      mode === 'live' &&
      (!config.writesEnabled ||
        !config.authToken ||
        disconnected ||
        !github.getConnectionStatus().writesEnabled)
    )
      return reply.code(403).send({ error: 'GitHub write authorization is no longer available.' });
    previews.delete(preview.id);
    previewSnapshots.delete(preview.id);
    executing.add(key);
    store.audit(
      mode,
      'action.started',
      `${mode === 'demo' ? 'Demo simulation: ' : ''}${preview.title}. Actor: ${mode === 'demo' ? 'demo operator' : 'authenticated local operator'}; GitHub actor: installation.`,
      preview.request.repository,
    );
    try {
      if (mode === 'live') await github.execute(preview.request, AbortSignal.timeout(60_000));
      store.audit(
        mode,
        'action.success',
        `${mode === 'demo' ? 'Simulated: ' : 'GitHub accepted: '}${preview.title}.`,
        preview.request.repository,
      );
      if (mode === 'live') sync.queue(mode, preview.request.repository);
      return {
        ok: true,
        simulated: mode === 'demo',
        message:
          mode === 'demo'
            ? 'Demo action simulated. GitHub was not contacted.'
            : 'GitHub accepted the operation. A repository refresh has been queued.',
      };
    } catch (error) {
      const message = safeMessage(error);
      store.audit(
        mode,
        'action.error',
        `${preview.title}: ${message}. Inspect GitHub before retrying; a partial operation may have completed.`,
        preview.request.repository,
      );
      return reply.code(502).send({ error: message });
    } finally {
      executing.delete(key);
    }
  });
  const staticRoot = resolve('apps/web/dist');
  if (existsSync(resolve(staticRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: staticRoot, index: ['index.html'] });
    app.setNotFoundHandler(async (request, reply) => {
      if (
        request.method === 'GET' &&
        !request.url.startsWith('/api/') &&
        !request.url.split('?')[0].includes('.')
      )
        return reply.type('text/html').sendFile('index.html');
      return reply.code(404).send({ error: 'Route not found.' });
    });
  }
  let maintenance: ReturnType<typeof setInterval> | undefined;
  if (options.background !== false) {
    sync.start();
    const retain = () => {
      for (const mode of ['live', 'demo'] as const)
        store.retention(store.settings(mode).retentionDays, mode);
      void backups
        .ifDue(config.backupIntervalHours ?? 24)
        .catch((error) => store.audit('live', 'database.backup.error', safeMessage(error)));
    };
    retain();
    maintenance = setInterval(retain, 60 * 60_000);
    maintenance.unref();
  }
  app.addHook('onClose', async () => {
    if (maintenance) clearInterval(maintenance);
    await sync.close();
    await backups.close();
    store.close();
  });
  return { app, store, sync };
}
