import { lazy, useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import {
  Activity,
  ArrowRight,
  Bell,
  Check,
  ChevronRight,
  CircleAlert,
  Database,
  FlaskConical,
  FolderGit2,
  GitFork,
  GitPullRequest,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Menu,
  Moon,
  Play,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sun,
  Terminal,
  X,
} from 'lucide-react';
import type { ActionPreview, ActionRequest, Dashboard, DataMode } from '@gitnostics/shared';
import {
  api,
  errorMessage,
  onSessionError,
  readMode,
  rememberMode,
  setCsrfToken,
  type Session,
} from './api';
import { AppContext } from './context';
import { Badge, Empty, FindingDialog, IconButton, Modal, Notifications } from './components';
import { dateLabel, latestSync, relative } from './format';
import { DeferredContent } from './deferred-content';

const OverviewPage = lazy(() =>
  import('./pages').then((module) => ({ default: module.OverviewPage })),
);
const RepositoriesPage = lazy(() =>
  import('./pages').then((module) => ({ default: module.RepositoriesPage })),
);
const RepositoryPage = lazy(() =>
  import('./pages').then((module) => ({ default: module.RepositoryPage })),
);
const FindingsPage = lazy(() =>
  import('./pages').then((module) => ({ default: module.FindingsPage })),
);
const ActivityPage = lazy(() =>
  import('./pages').then((module) => ({ default: module.ActivityPage })),
);
const ActionsPage = lazy(() =>
  import('./investigations').then((module) => ({ default: module.ActionsPage })),
);
const PullRequestsPage = lazy(() =>
  import('./investigations').then((module) => ({ default: module.PullRequestsPage })),
);
const StoragePage = lazy(() =>
  import('./storage-actions').then((module) => ({ default: module.StoragePage })),
);
const SafeActionsPage = lazy(() =>
  import('./storage-actions').then((module) => ({ default: module.SafeActionsPage })),
);
const SettingsPage = lazy(() =>
  import('./settings').then((module) => ({ default: module.SettingsPage })),
);

const navigation = [
  { to: '/', label: 'Overview', icon: LayoutDashboard },
  { to: '/repositories', label: 'Repositories', icon: FolderGit2 },
  { to: '/pull-requests', label: 'Pull requests', icon: GitPullRequest },
  { to: '/actions', label: 'Actions', icon: Play },
  { to: '/storage', label: 'Storage', icon: Database },
  { to: '/findings', label: 'Findings', icon: CircleAlert },
  { to: '/activity', label: 'Activity', icon: Activity },
];

export function App() {
  const client = useQueryClient();
  const location = useLocation();
  const [mode, setMode] = useState<DataMode>(readMode);
  const [pending, setPending] = useState(0);
  const [toast, setToast] = useState<{ message: string; error?: boolean }>();
  const [mobile, setMobile] = useState(false);
  const [notifications, setNotifications] = useState(false);
  const [findingId, setFindingId] = useState<string>();
  const [actionPreview, setActionPreview] = useState<ActionPreview>();
  const [confirmation, setConfirmation] = useState('');
  const [operatorToken, setOperatorToken] = useState('');
  const [loginError, setLoginError] = useState('');
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const sessionGeneration = useRef(0);
  const resetSession = useCallback(() => {
    sessionGeneration.current += 1;
    void client.cancelQueries({ queryKey: ['dashboard'] });
    client.removeQueries({ queryKey: ['dashboard'] });
    client.removeQueries({ queryKey: ['session'] });
    setCsrfToken('');
    setActionPreview(undefined);
    setConfirmation('');
    setFindingId(undefined);
    setNotifications(false);
    setOperatorToken('');
    setSessionEpoch(sessionGeneration.current);
  }, [client]);
  useEffect(() => onSessionError(resetSession), [resetSession]);
  const session = useQuery({
    queryKey: ['session', sessionEpoch],
    queryFn: async ({ signal }) => {
      const value = await api<Session>('/api/session', { signal });
      setCsrfToken(value.csrfToken);
      return value;
    },
    staleTime: 10 * 60_000,
    retry: false,
  });
  const dashboard = useQuery({
    queryKey: ['dashboard', mode, sessionEpoch],
    enabled: Boolean(session.data && (!session.data.requiresLogin || session.data.authenticated)),
    queryFn: ({ signal }) => api<Dashboard>('/api/dashboard', { mode, signal }),
    refetchInterval: (query) =>
      query.state.data?.repositories.some((r) => ['queued', 'syncing'].includes(r.syncStatus))
        ? 2_000
        : false,
  });
  useEffect(() => {
    if (session.data) setCsrfToken(session.data.csrfToken);
  }, [session.data]);
  const data = dashboard.data;
  const syncing =
    data?.repositories.some((r) => ['queued', 'syncing'].includes(r.syncStatus)) ?? false;
  useEffect(() => {
    setMobile(false);
    window.scrollTo(0, 0);
  }, [location.pathname]);
  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(undefined), toast.error ? 10_000 : 4_000);
    return () => window.clearTimeout(timeout);
  }, [toast]);
  useEffect(() => {
    const theme = data?.settings.theme ?? 'dark';
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [data?.settings.theme]);

  async function mutate<T = unknown>(
    path: string,
    body: unknown,
    success: string,
    method = 'POST',
  ): Promise<T | undefined> {
    const generation = sessionGeneration.current;
    setPending((value) => value + 1);
    try {
      const result = await api<T>(path, { method, body, mode });
      if (generation !== sessionGeneration.current) return undefined;
      await client.invalidateQueries({ queryKey: ['dashboard', mode] });
      if (generation !== sessionGeneration.current) return undefined;
      setToast({ message: success });
      return result;
    } catch (error) {
      if (generation === sessionGeneration.current)
        setToast({ message: errorMessage(error), error: true });
      return undefined;
    } finally {
      setPending((value) => value - 1);
    }
  }
  async function preview(request: ActionRequest) {
    const result = await mutate<ActionPreview>(
      '/api/actions/preview',
      request,
      'Impact preview ready',
    );
    if (result) {
      setActionPreview(result);
      setConfirmation('');
    }
  }
  async function switchMode() {
    if (mode === 'demo') {
      setMode('live');
      rememberMode('live');
      setFindingId(undefined);
      setActionPreview(undefined);
      return;
    }
    const result = await mutate(
      '/api/demo/reset',
      {},
      'Demo workspace ready. All data and actions are simulated.',
    );
    if (result !== undefined) {
      setMode('demo');
      rememberMode('demo');
      setFindingId(undefined);
      setActionPreview(undefined);
      await client.invalidateQueries({ queryKey: ['dashboard', 'demo'] });
    }
  }
  async function login(event: React.FormEvent) {
    event.preventDefault();
    setPending((value) => value + 1);
    setLoginError('');
    try {
      const fresh = await api<Session>('/api/session');
      setCsrfToken(fresh.csrfToken);
      const result = await api<{ csrfToken: string }>('/api/login', {
        method: 'POST',
        body: { token: operatorToken },
      });
      setCsrfToken(result.csrfToken);
      setOperatorToken('');
      await client.invalidateQueries({ queryKey: ['session'] });
    } catch (error) {
      setLoginError(errorMessage(error));
    } finally {
      setPending((value) => value - 1);
    }
  }
  async function logout() {
    setPending((value) => value + 1);
    try {
      const fresh = await api<Session>('/api/session');
      setCsrfToken(fresh.csrfToken);
      await api('/api/logout', { method: 'POST', body: {} });
      resetSession();
    } catch (error) {
      setToast({ message: errorMessage(error), error: true });
    } finally {
      setPending((value) => value - 1);
    }
  }

  if (!session.data || (session.data.requiresLogin && !session.data.authenticated))
    return (
      <div className="startup-screen">
        <div className="startup-brand">
          <Terminal size={25} />
          <span>GitNostics</span>
        </div>
        {session.isError ? (
          <Empty
            title="Could not reach the local server"
            action={
              <button className="button" onClick={() => void session.refetch()}>
                Try again
              </button>
            }
          >
            {errorMessage(session.error)}
          </Empty>
        ) : session.data?.requiresLogin ? (
          <form className="login-panel panel" onSubmit={(event) => void login(event)}>
            <LockKeyhole size={26} />
            <h1>Unlock your workspace</h1>
            <p>
              Enter the operator token configured on your GitNostics server. The token stays out of
              browser storage.
            </p>
            <label>
              Operator token
              <input
                type="password"
                autoComplete="off"
                required
                value={operatorToken}
                onChange={(event) => setOperatorToken(event.target.value)}
              />
            </label>
            {loginError && (
              <div role="alert" className="error-message">
                {loginError}
              </div>
            )}
            <button className="button primary" disabled={pending > 0}>
              {pending > 0 ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <LockKeyhole size={16} />
              )}
              Sign in
            </button>
          </form>
        ) : (
          <div className="startup-loading">
            <LoaderCircle className="spin" size={22} />
            <span>Opening local workspace</span>
          </div>
        )}
      </div>
    );

  const pageTitle = location.pathname.startsWith('/repositories/')
    ? 'Repository detail'
    : ([
        ...navigation,
        { to: '/safe-actions', label: 'Safe action center' },
        { to: '/settings', label: 'Settings' },
      ].find((item) => item.to === location.pathname)?.label ?? 'Workspace');
  const unread = data?.notifications.filter((n) => !n.read).length ?? 0;
  const busy = pending > 0;
  return (
    <div className="app-shell">
      {mobile && (
        <button
          className="mobile-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        />
      )}
      <aside className={`sidebar ${mobile ? 'is-open' : ''}`} aria-label="Main navigation">
        <Link className="brand" to="/">
          <div className="brand-symbol">
            <Terminal size={23} strokeWidth={2.4} />
          </div>
          <span>
            GitNostics<small>DIAGNOSE. UNDERSTAND. RESOLVE.</small>
          </span>
        </Link>
        <div className="workspace-switch">
          <GitFork size={17} />
          <div>
            <strong>Local workspace</strong>
            <span>{mode === 'demo' ? 'Isolated demo data' : 'GitHub diagnostics'}</span>
          </div>
          <Badge>{mode}</Badge>
        </div>
        <div className="nav-section-label">WORKSPACE</div>
        <nav>
          {navigation.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              onClick={() => setMobile(false)}
              className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
            >
              <Icon size={18} strokeWidth={1.7} />
              <span>{label}</span>
              {to === '/findings' &&
                data &&
                data.findings.some((f) => ['new', 'active'].includes(f.status)) && (
                  <span className="nav-count">
                    {data.findings.filter((f) => ['new', 'active'].includes(f.status)).length}
                  </span>
                )}
            </NavLink>
          ))}
        </nav>
        <div className="nav-section-label tools-label">RESOLVE</div>
        <NavLink
          to="/safe-actions"
          className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
        >
          <ShieldCheck size={18} strokeWidth={1.7} />
          <span>Safe action center</span>
        </NavLink>
        <div className="sidebar-bottom">
          <div className="connection-mini">
            <span className={`state-dot ${data?.connection.connected ? 'green' : 'amber'}`} />
            <div>
              <strong>
                {mode === 'demo'
                  ? 'Demo workspace'
                  : data?.connection.mode === 'public'
                    ? data.connection.connected
                      ? 'Public repository mode'
                      : 'Connection unavailable'
                    : data?.connection.connected
                      ? data.connection.mode === 'development_pat'
                        ? 'Development PAT connected'
                        : 'GitHub App connected'
                      : 'Integration unverified'}
              </strong>
              <span>
                {mode === 'demo'
                  ? 'Simulated actions only'
                  : data?.connection.writesEnabled
                    ? 'Approved writes enabled'
                    : 'Read-only by default'}
              </span>
            </div>
            <LockKeyhole size={14} />
          </div>
          <NavLink
            to="/settings"
            className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
          >
            <Settings2 size={18} strokeWidth={1.7} />
            <span>Settings</span>
          </NavLink>
          <div className="sidebar-footer">
            <span>Self-hosted · local-first</span>
            <span className="mono">v0.1.0</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <IconButton
              label="Open navigation"
              onClick={() => setMobile(true)}
              className="icon-button mobile-menu"
            >
              <Menu size={21} />
            </IconButton>
            <span className="breadcrumb-workspace">Workspace</span>
            <ChevronRight size={13} />
            <strong>{pageTitle}</strong>
          </div>
          <div className="topbar-actions">
            <span
              className="topbar-cache"
              title={dateLabel(data ? latestSync(data.repositories) : null)}
            >
              <span className={`state-dot ${syncing ? 'amber' : ''}`} />
              {syncing
                ? 'Synchronizing'
                : `Cached ${relative(data ? latestSync(data.repositories) : null)}`}
            </span>
            <IconButton
              label="Refresh local view"
              onClick={() => void dashboard.refetch()}
              disabled={dashboard.isFetching}
            >
              <RefreshCw size={16} className={dashboard.isFetching ? 'spin' : ''} />
            </IconButton>
            <IconButton
              label={data?.settings.theme === 'light' ? 'Use dark theme' : 'Use light theme'}
              onClick={() =>
                data &&
                void mutate(
                  '/api/settings',
                  { ...data.settings, theme: data.settings.theme === 'light' ? 'dark' : 'light' },
                  'Theme updated',
                  'PUT',
                )
              }
              disabled={!data || busy}
            >
              {data?.settings.theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
            </IconButton>
            <button
              className="icon-button notification-button"
              aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
              title="Notifications"
              onClick={() => setNotifications(true)}
              disabled={!data}
            >
              <Bell size={17} />
              {unread > 0 && <span />}
            </button>
            {session.data.requiresLogin && (
              <IconButton label="Sign out" onClick={() => void logout()} disabled={busy}>
                <LogOut size={17} />
              </IconButton>
            )}
            <div className="operator-avatar" title={data?.connection.identity || 'Local operator'}>
              L
            </div>
          </div>
        </header>
        {mode === 'demo' && (
          <div className="demo-banner">
            <FlaskConical size={15} />
            <span>
              <strong>Demo workspace.</strong> Fixture data and simulated actions. No GitHub
              changes.
            </span>
            <button onClick={() => void switchMode()}>
              Return to live <ArrowRight size={13} />
            </button>
          </div>
        )}
        {dashboard.isError && (
          <div className="fetch-error" role="alert">
            <CircleAlert size={17} />
            <span>{errorMessage(dashboard.error)}</span>
            <button onClick={() => void dashboard.refetch()}>Retry</button>
          </div>
        )}
        {data ? (
          <AppContext.Provider
            value={{
              data,
              mode,
              busy,
              mutate,
              preview,
              inspect: setFindingId,
              refresh: () => {
                void dashboard.refetch();
              },
            }}
          >
            <main id="main-content" className="main-content">
              <DeferredContent key={location.pathname} label="Loading page...">
                <Routes>
                  <Route
                    path="/"
                    element={<OverviewPage exploreDemo={() => void switchMode()} />}
                  />
                  <Route path="/repositories" element={<RepositoriesPage />} />
                  <Route path="/repositories/:owner/:repo" element={<RepositoryPage />} />
                  <Route path="/pull-requests" element={<PullRequestsPage />} />
                  <Route path="/actions" element={<ActionsPage />} />
                  <Route path="/storage" element={<StoragePage />} />
                  <Route path="/findings" element={<FindingsPage />} />
                  <Route path="/activity" element={<ActivityPage />} />
                  <Route
                    path="/settings"
                    element={<SettingsPage exploreDemo={() => void switchMode()} />}
                  />
                  <Route path="/safe-actions" element={<SafeActionsPage />} />
                  <Route
                    path="*"
                    element={
                      <Empty
                        title="Page not found"
                        action={
                          <Link to="/" className="button">
                            Back to overview
                          </Link>
                        }
                      >
                        This workspace page doesn't exist.
                      </Empty>
                    }
                  />
                </Routes>
              </DeferredContent>
            </main>
            <FindingDialog
              key={findingId ?? 'closed'}
              finding={data.findings.find((f) => f.id === findingId)}
              close={() => setFindingId(undefined)}
            />
            <Notifications open={notifications} close={() => setNotifications(false)} />
          </AppContext.Provider>
        ) : (
          <main className="main-content">
            <div className="page-loading">
              <LoaderCircle className="spin" size={22} />
              <p>Loading workspace data</p>
            </div>
          </main>
        )}
        <footer className="main-footer">
          <span>
            <ShieldCheck size={13} />
            Evidence first. Your repositories stay in your control.
          </span>
          <span>{mode === 'demo' ? 'DEMO DATA' : 'CACHED GITHUB DATA'}</span>
        </footer>
      </div>
      {toast && (
        <div
          className={`toast ${toast.error ? 'error' : ''}`}
          role={toast.error ? 'alert' : 'status'}
          aria-live={toast.error ? 'assertive' : 'polite'}
        >
          {toast.error ? <CircleAlert size={18} /> : <Check size={18} />}
          <span>{toast.message}</span>
          <IconButton label="Dismiss message" onClick={() => setToast(undefined)}>
            <X size={16} />
          </IconButton>
        </div>
      )}
      <Modal
        open={Boolean(actionPreview)}
        onOpenChange={(open) => {
          if (!open && !busy) setActionPreview(undefined);
        }}
        title={actionPreview?.title ?? 'Action preview'}
        description="Review the operation and its impact before confirming."
        wide
      >
        {actionPreview && (
          <>
            <div className="inline-meta">
              <Badge tone={actionPreview.destructive ? 'high' : 'medium'}>
                {actionPreview.destructive ? 'Destructive operation' : 'Workflow operation'}
              </Badge>
              <Badge>{actionPreview.mode === 'demo' ? 'SIMULATION ONLY' : 'GitHub write'}</Badge>
              <span className="mono">{actionPreview.request.repository}</span>
            </div>
            <div className="evidence-section">
              <h3>Expected impact</h3>
              <ul className="impact-list">
                {actionPreview.impact.map((impact, i) => (
                  <li key={i}>{impact}</li>
                ))}
              </ul>
            </div>
            {!actionPreview.allowed && (
              <div className="permission-notice">
                <LockKeyhole size={18} />
                <div>
                  <strong>Execution is unavailable</strong>
                  <p>
                    {actionPreview.reason ?? 'This operation has not passed permission checks.'}
                  </p>
                </div>
              </div>
            )}
            <p className="muted small">
              Preview expires {dateLabel(actionPreview.expiresAt)}. Permissions are verified again
              during execution.
            </p>
            {actionPreview.allowed && (
              <label className="confirmation-input">
                Type <code>{actionPreview.confirmation}</code> to confirm
                <input
                  aria-label="Action confirmation"
                  autoComplete="off"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  placeholder="Enter exact confirmation text"
                />
              </label>
            )}
            <div className="dialog-actions">
              <button
                className="button"
                disabled={busy}
                onClick={() => setActionPreview(undefined)}
              >
                Cancel
              </button>
              <button
                className={`button ${actionPreview.destructive ? 'danger' : 'primary'}`}
                disabled={
                  !actionPreview.allowed ||
                  confirmation !== actionPreview.confirmation ||
                  busy ||
                  Date.parse(actionPreview.expiresAt) < Date.now()
                }
                onClick={() => {
                  void mutate(
                    '/api/actions/execute',
                    { previewId: actionPreview.id, confirmation },
                    actionPreview.mode === 'demo'
                      ? 'Demo operation simulated. No GitHub data was changed.'
                      : 'GitHub operation completed',
                  ).then((result) => {
                    if (result !== undefined) {
                      setActionPreview(undefined);
                      setConfirmation('');
                    }
                  });
                }}
              >
                <ShieldCheck size={15} />
                {actionPreview.mode === 'demo' ? 'Simulate action' : 'Confirm and execute'}
              </button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
