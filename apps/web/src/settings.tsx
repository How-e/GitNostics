import { useEffect, useRef, useState } from 'react';
import {
  FlaskConical,
  FolderGit2,
  LockKeyhole,
  Moon,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Sun,
  Unplug,
} from 'lucide-react';
import type { AppSettings, RepositoryDiscovery } from '@gitnostics/shared';
import { api, errorMessage } from './api';
import { useApp } from './context';
import { Badge, Empty, Modal, PageHeading, Panel } from './components';
import { dateLabel, repoPath } from './format';

interface DiscoveredRepository {
  fullName: string;
  private: boolean;
}
export function SettingsPage({ exploreDemo }: { exploreDemo: () => void }) {
  const { data, mode, busy, mutate } = useApp();
  const [settings, setSettings] = useState<AppSettings>(data.settings);
  const [retentionDays, setRetentionDays] = useState(String(data.settings.retentionDays));
  const [artifactAgeDays, setArtifactAgeDays] = useState(String(data.settings.artifactAgeDays));
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredRepository[]>();
  const [discoveryComplete, setDiscoveryComplete] = useState(true);
  const discoveryRequest = useRef<AbortController | null>(null);
  const discoveryContext = useRef({ workspaceMode: mode, connection: data.connection });
  const [discoveryError, setDiscoveryError] = useState('');
  const [query, setQuery] = useState('');
  const [disconnect, setDisconnect] = useState(false);
  useEffect(() => {
    setSettings(data.settings);
    setRetentionDays(String(data.settings.retentionDays));
    setArtifactAgeDays(String(data.settings.artifactAgeDays));
  }, [data.settings]);
  useEffect(() => {
    const previous = discoveryContext.current;
    discoveryContext.current = { workspaceMode: mode, connection: data.connection };
    const changed =
      previous.workspaceMode !== mode ||
      previous.connection.mode !== data.connection.mode ||
      previous.connection.identity !== data.connection.identity ||
      (previous.connection.connected && !data.connection.connected);
    if (!changed) return;
    discoveryRequest.current?.abort();
    setDiscovered(undefined);
    setDiscoveryError('');
    setDiscovering(false);
    setDiscoveryComplete(true);
    setQuery('');
  }, [mode, data.connection]);
  useEffect(() => () => discoveryRequest.current?.abort(), []);
  const change = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    setSettings((previous) => ({ ...previous, [key]: value }));
  const dirty =
    JSON.stringify(settings) !== JSON.stringify(data.settings) ||
    retentionDays !== String(data.settings.retentionDays) ||
    artifactAgeDays !== String(data.settings.artifactAgeDays);
  const validDays = (value: string, minimum: number) =>
    value.trim() !== '' &&
    Number.isInteger(Number(value)) &&
    Number(value) >= minimum &&
    Number(value) <= 365;
  const retentionValid = validDays(retentionDays, 7);
  const artifactAgeValid = validDays(artifactAgeDays, 1);
  const canSave = dirty && !busy && retentionValid && artifactAgeValid;
  const save = () => {
    if (!canSave) return;
    void mutate(
      '/api/settings',
      {
        ...settings,
        retentionDays: Number(retentionDays),
        artifactAgeDays: Number(artifactAgeDays),
      },
      'Workspace preferences saved',
      'PUT',
    );
  };
  const discover = async () => {
    discoveryRequest.current?.abort();
    const controller = new AbortController();
    discoveryRequest.current = controller;
    setDiscovering(true);
    setDiscoveryError('');
    try {
      const result = await api<RepositoryDiscovery>('/api/connection/discovery', {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setDiscovered(result.repositories);
      setDiscoveryComplete(result.complete);
    } catch (error) {
      if (!controller.signal.aborted) setDiscoveryError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setDiscovering(false);
    }
  };
  return (
    <>
      <PageHeading
        title="Workspace settings"
        description="Connections, monitoring preferences, and the rules that shape your diagnostics."
        action={
          <button className="button primary" disabled={!canSave} onClick={save}>
            <Save size={15} />
            Save preferences
          </button>
        }
      />
      <div className="settings-layout">
        <div className="settings-main">
          <Panel
            title="GitHub connection"
            description="Credentials stay on the server. This browser never receives a GitHub token."
            action={
              <Badge tone={data.connection.connected ? 'success' : 'neutral'}>
                {mode === 'demo'
                  ? 'Demo simulation'
                  : data.connection.connected
                    ? 'Connected'
                    : 'Connection unavailable'}
              </Badge>
            }
          >
            <div className="connection-card">
              <div className="connection-avatar">
                <FolderGit2 size={25} />
              </div>
              <div>
                <strong>{data.connection.identity || 'Public GitHub repositories'}</strong>
                <span>
                  {data.connection.mode === 'app'
                    ? 'GitHub App installation'
                    : data.connection.mode === 'development_pat'
                      ? 'Development-only personal access token'
                      : 'Unauthenticated public repository access'}
                </span>
              </div>
              <Badge>
                <LockKeyhole size={11} />
                {data.connection.writesEnabled && mode !== 'demo' ? 'Writes opted in' : 'Read-only'}
              </Badge>
            </div>
            {data.connection.error && (
              <div className="permission-notice">
                <LockKeyhole size={16} />
                <p>{data.connection.error}</p>
              </div>
            )}
            {data.connection.rateLimit && (
              <div className="rate-limit">
                <span>GitHub API budget</span>
                <strong className="mono">
                  {data.connection.rateLimit.remaining} / {data.connection.rateLimit.limit}
                </strong>
                <span>Resets {dateLabel(data.connection.rateLimit.resetAt)}</span>
              </div>
            )}
            <div className="settings-section">
              <h3>Configure access on your server</h3>
              <p>
                For private repositories, create a least-privilege GitHub App and configure its
                application ID, installation ID, and private key on the server. Restart GitNostics
                after changing connection environment variables.
              </p>
              <p className="small muted">
                See <code>docs/GITHUB_APP_SETUP.md</code> and <code>.env.example</code> in the
                project. A development PAT is restricted to development mode. Public repository
                access works without credentials.
              </p>
              <div className="button-row">
                <button
                  className="button"
                  disabled={discovering || mode === 'demo'}
                  onClick={() => void discover()}
                >
                  <Search size={14} />
                  {discovering ? 'Discovering…' : 'Discover accessible repositories'}
                </button>
                {data.connection.connected && mode === 'live' && (
                  <button
                    className="button danger-quiet"
                    disabled={busy}
                    onClick={() => setDisconnect(true)}
                  >
                    <Unplug size={14} />
                    Disconnect
                  </button>
                )}
              </div>
              {mode === 'demo' && (
                <p className="input-help">
                  Repository discovery is available in the live workspace.
                </p>
              )}
              {discoveryError && (
                <p className="error-message" role="alert">
                  {discoveryError}
                </p>
              )}
              {discovered && (
                <div className="discovery-results">
                  {!discoveryComplete && (
                    <p className="permission-notice" role="status">
                      Discovery reached its 500-repository limit. This list is incomplete. Add a
                      missing accessible owner/repository from Repositories.
                    </p>
                  )}
                  <label className="form-field">
                    Find an accessible repository
                    <input
                      aria-label="Search discovered repositories"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Filter discovered repositories"
                    />
                  </label>
                  {discovered
                    .filter((repository) =>
                      repository.fullName.toLowerCase().includes(query.toLowerCase()),
                    )
                    .map((repository) => {
                      const monitored = data.repositories.find(
                        (r) => r.fullName === repository.fullName,
                      );
                      return (
                        <div className="discovery-row" key={repository.fullName}>
                          <div>
                            <strong>{repository.fullName}</strong>
                            <span>
                              {repository.private ? 'Private repository' : 'Public repository'}
                            </span>
                          </div>
                          <button
                            className="button small-button"
                            disabled={Boolean(monitored) || busy}
                            onClick={() =>
                              void mutate(
                                '/api/repositories',
                                { fullName: repository.fullName },
                                'Repository added to your workspace',
                              )
                            }
                          >
                            {monitored ? 'Added' : 'Add repository'}
                          </button>
                        </div>
                      );
                    })}
                  {!discovered.length && (
                    <Empty title="No repositories returned">
                      {data.connection.mode === 'public'
                        ? 'Public mode does not enumerate an account. Add a public owner/repository from Repositories, or configure a GitHub App.'
                        : 'No accessible repositories were returned for this connection. Review installation repository access, or add an accessible owner/repository from Repositories.'}
                    </Empty>
                  )}
                  {discovered.length > 0 &&
                    !discovered.some((repository) =>
                      repository.fullName.toLowerCase().includes(query.toLowerCase()),
                    ) && <Empty title="No matching repositories">Try another search.</Empty>}
                </div>
              )}
            </div>
          </Panel>
          <Panel
            title="Repository monitoring"
            description="Only monitored repositories participate in synchronization."
          >
            {data.repositories.length ? (
              <div className="settings-repo-list">
                {data.repositories.map((repository) => (
                  <label className="toggle-row" key={repository.fullName}>
                    <div>
                      <strong>{repository.fullName}</strong>
                      <span>
                        {repository.selected
                          ? 'Included in manual and scheduled synchronization'
                          : 'Monitoring paused; enable to synchronize'}
                      </span>
                    </div>
                    <input
                      type="checkbox"
                      aria-label={`Monitor ${repository.fullName}`}
                      checked={repository.selected}
                      disabled={busy}
                      onChange={(event) =>
                        void mutate(
                          repoPath(repository.fullName),
                          { selected: event.target.checked },
                          'Repository monitoring updated',
                          'PATCH',
                        )
                      }
                    />
                  </label>
                ))}
              </div>
            ) : (
              <Empty title="No monitored repositories">
                Add a repository from the command center to configure monitoring.
              </Empty>
            )}
          </Panel>
          <Panel
            title="Synchronization & retention"
            description="Choose when GitHub evidence refreshes and how long local history is retained."
          >
            <div className="settings-fields">
              <label>
                Background synchronization
                <select
                  value={settings.syncIntervalMinutes}
                  aria-label="Background synchronization"
                  onChange={(event) => change('syncIntervalMinutes', Number(event.target.value))}
                >
                  <option value="0">Manual only</option>
                  {[5, 15, 30, 60, 180, 360, 720, 1440].map((value) => (
                    <option key={value} value={value}>
                      Every {value >= 60 ? `${value / 60} hours` : `${value} minutes`}
                    </option>
                  ))}
                  {![0, 5, 15, 30, 60, 180, 360, 720, 1440].includes(
                    settings.syncIntervalMinutes,
                  ) && (
                    <option value={settings.syncIntervalMinutes}>
                      Every {settings.syncIntervalMinutes} minutes
                    </option>
                  )}
                </select>
                <span className="input-help">
                  Manual sync stays available for monitored repositories.
                </span>
              </label>
              <label>
                Local history retention (days)
                <input
                  aria-label="Local history retention"
                  type="number"
                  min={7}
                  max={365}
                  step={1}
                  aria-invalid={!retentionValid}
                  aria-describedby={
                    retentionValid ? 'retention-help' : 'retention-help retention-error'
                  }
                  value={retentionDays}
                  onChange={(event) => setRetentionDays(event.target.value)}
                />
                <span className="input-help" id="retention-help">
                  Keep 7–365 days of local diagnostic and activity history.
                </span>
                {!retentionValid && (
                  <span className="error-message" id="retention-error" role="alert">
                    Enter a whole number from 7 to 365 days.
                  </span>
                )}
              </label>
              <label>
                Artifact review age (days)
                <input
                  aria-label="Artifact review age"
                  type="number"
                  min={1}
                  max={365}
                  step={1}
                  aria-invalid={!artifactAgeValid}
                  aria-describedby={
                    artifactAgeValid ? 'artifact-age-help' : 'artifact-age-help artifact-age-error'
                  }
                  value={artifactAgeDays}
                  onChange={(event) => setArtifactAgeDays(event.target.value)}
                />
                <span className="input-help" id="artifact-age-help">
                  Artifacts older than this become cleanup candidates. Nothing is auto-deleted.
                </span>
                {!artifactAgeValid && (
                  <span className="error-message" id="artifact-age-error" role="alert">
                    Enter a whole number from 1 to 365 days.
                  </span>
                )}
              </label>
            </div>
          </Panel>
          <Panel
            title="Notifications & diagnostic rules"
            description="Control the findings that need your attention."
          >
            <div className="settings-fields">
              <label className="toggle-row">
                <div>
                  <strong>In-app finding notifications</strong>
                  <span>Surface newly detected diagnostics in this workspace.</span>
                </div>
                <input
                  type="checkbox"
                  aria-label="Enable notifications"
                  checked={settings.notificationsEnabled}
                  onChange={(event) => change('notificationsEnabled', event.target.checked)}
                />
              </label>
              <label>
                Minimum notification severity
                <select
                  aria-label="Minimum notification severity"
                  value={settings.minimumSeverity}
                  onChange={(event) =>
                    change('minimumSeverity', event.target.value as AppSettings['minimumSeverity'])
                  }
                >
                  {['critical', 'high', 'medium', 'low', 'info'].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <div>
                <h3>Suppressed rules</h3>
                <p className="muted small">
                  Rules can be suppressed from any finding's evidence dialog. Restore them here,
                  then save preferences.
                </p>
                {settings.suppressedRules.length ? (
                  <div className="suppressed-rules">
                    {settings.suppressedRules.map((rule) => (
                      <div key={rule}>
                        <code>{rule}</code>
                        <button
                          className="text-link"
                          onClick={() =>
                            change(
                              'suppressedRules',
                              settings.suppressedRules.filter((value) => value !== rule),
                            )
                          }
                        >
                          Restore rule
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <span className="muted small">No suppressed rules.</span>
                )}
              </div>
            </div>
          </Panel>
          <Panel title="Appearance" description="Choose a workspace theme.">
            <div className="theme-options">
              {(['dark', 'light', 'system'] as const).map((theme) => (
                <button
                  key={theme}
                  className={`theme-option ${settings.theme === theme ? 'chosen' : ''}`}
                  aria-pressed={settings.theme === theme}
                  onClick={() => change('theme', theme)}
                >
                  <span>
                    {theme === 'dark' ? (
                      <Moon size={19} />
                    ) : theme === 'light' ? (
                      <Sun size={19} />
                    ) : (
                      <Settings2 size={19} />
                    )}
                  </span>
                  <strong>{theme[0].toUpperCase() + theme.slice(1)}</strong>
                </button>
              ))}
            </div>
          </Panel>
          <div className="settings-save-bar">
            <span>
              {dirty ? 'You have unsaved preferences.' : 'All workspace preferences are saved.'}
            </span>
            <button className="button primary" disabled={!canSave} onClick={save}>
              <Save size={15} />
              Save preferences
            </button>
          </div>
        </div>
        <aside className="settings-aside">
          <div className="permission-notice">
            <ShieldCheck size={19} />
            <div>
              <strong>Read-only is the default</strong>
              <p>
                Enabling writes requires both a server-level opt-in and operator authentication.
                Permissions are verified before every action.
              </p>
            </div>
          </div>
          <Panel title="Workspace data">
            <div className="settings-section">
              <Badge>{mode === 'demo' ? 'DEMO DATA' : 'CACHED GITHUB DATA'}</Badge>
              <p>
                {mode === 'demo'
                  ? 'This workspace uses local fixtures. All operations are simulated and stored separately from GitHub data.'
                  : 'Live workspace data comes from cached GitHub responses. Every repository displays its last synchronization time.'}
              </p>
              <button className="button" disabled={busy} onClick={exploreDemo}>
                <FlaskConical size={15} />
                {mode === 'demo' ? 'Return to live workspace' : 'Explore demo'}
              </button>
            </div>
          </Panel>
          <div className="form-note">
            <LockKeyhole size={15} />
            <p>
              GitHub secrets belong in server configuration. Never paste them into diagnostic
              fields, repository names, or issue reports.
            </p>
          </div>
        </aside>
      </div>
      <Modal
        open={disconnect}
        onOpenChange={setDisconnect}
        title="Disconnect GitHub?"
        description="Disable the current server connection for this running session. Cached diagnostic data remains available."
      >
        <p>
          Server environment credentials are not deleted by this action. Remove those from your
          server configuration to keep them disconnected after restart.
        </p>
        <div className="dialog-actions">
          <button className="button" onClick={() => setDisconnect(false)}>
            Cancel
          </button>
          <button
            className="button danger"
            disabled={busy}
            onClick={() =>
              void mutate('/api/connection/disconnect', {}, 'GitHub connection disconnected').then(
                (result) => {
                  if (result !== undefined) setDisconnect(false);
                },
              )
            }
          >
            Disconnect
          </button>
        </div>
      </Modal>
    </>
  );
}
