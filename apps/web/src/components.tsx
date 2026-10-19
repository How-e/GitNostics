import type { ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDot,
  Clock3,
  GitPullRequest,
  Inbox,
  LoaderCircle,
  ShieldCheck,
  X,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Finding, FindingStatus, RepositoryRecord } from '@gitnostics/shared';
import { dateLabel, relative, repositoryHref, safeExternalUrl, unresolved } from './format';
import { useApp } from './context';

export function IconButton({
  label,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return (
    <button type="button" className="icon-button" aria-label={label} title={label} {...props}>
      {children}
    </button>
  );
}
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge tone-${tone}`}>{children}</span>;
}
export function Status({ value }: { value: string }) {
  const good = ['success', 'resolved', 'idle', 'confirmed'].includes(value);
  const bad = ['failure', 'error', 'critical', 'high', 'changes_requested'].includes(value);
  const pending = [
    'pending',
    'queued',
    'syncing',
    'in_progress',
    'new',
    'medium',
    'probable',
  ].includes(value);
  const Icon = good ? CircleCheck : bad ? CircleAlert : pending ? Clock3 : CircleDot;
  return (
    <span className={`status ${good ? 'good' : bad ? 'bad' : pending ? 'warn' : 'muted'}`}>
      <Icon size={13} />
      {value.replaceAll('_', ' ')}
    </span>
  );
}
export function ExternalLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  const safe = safeExternalUrl(href);
  return safe ? (
    <a
      className={className ?? 'external-link'}
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
      <ArrowUpRight size={13} />
    </a>
  ) : (
    <span>{children}</span>
  );
}
export function Panel({
  title,
  description,
  action,
  children,
  className = '',
}: {
  title?: ReactNode;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {title && (
        <header className="panel-heading">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}
export function Empty({
  title,
  children,
  icon,
  action,
}: {
  title: string;
  children?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon ?? <Inbox size={25} />}</div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
export function Metric({
  label,
  value,
  detail,
  icon,
  to,
  tone = '',
}: {
  label: string;
  value: ReactNode;
  detail: ReactNode;
  icon: ReactNode;
  to: string;
  tone?: string;
}) {
  return (
    <Link className={`metric ${tone}`} to={to}>
      <div className="metric-label">
        {label}
        {icon}
      </div>
      <strong>{value}</strong>
      <div className="metric-detail">
        {detail}
        <ArrowUpRight size={14} />
      </div>
    </Link>
  );
}
export function PageHeading({
  title,
  description,
  action,
  eyebrow,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action && <div className="heading-actions">{action}</div>}
    </div>
  );
}
export function SearchField({
  placeholder = 'Search',
  parameter = 'q',
}: {
  placeholder?: string;
  parameter?: string;
}) {
  const [params, setParams] = useSearchParams();
  return (
    <input
      aria-label={placeholder}
      className="search-input"
      placeholder={placeholder}
      value={params.get(parameter) ?? ''}
      onChange={(event) => {
        setParams(
          (previous) => {
            const next = new URLSearchParams(previous);
            if (event.target.value) next.set(parameter, event.target.value);
            else next.delete(parameter);
            next.delete('page');
            return next;
          },
          { replace: true },
        );
      }}
    />
  );
}
export function FilterSelect({
  label,
  parameter,
  children,
}: {
  label: string;
  parameter: string;
  children: ReactNode;
}) {
  const [params, setParams] = useSearchParams();
  return (
    <label className="filter-label">
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        value={params.get(parameter) ?? ''}
        onChange={(event) =>
          setParams(
            (previous) => {
              const next = new URLSearchParams(previous);
              if (event.target.value) next.set(parameter, event.target.value);
              else next.delete(parameter);
              next.delete('page');
              return next;
            },
            { replace: true },
          )
        }
      >
        {children}
      </select>
    </label>
  );
}
export function RepositoryFilter() {
  const { data } = useApp();
  return (
    <FilterSelect label="Filter by repository" parameter="repo">
      <option value="">All repositories</option>
      {data.repositories.map((r) => (
        <option key={r.fullName} value={r.fullName}>
          {r.fullName}
        </option>
      ))}
    </FilterSelect>
  );
}
export function Pagination({ total, size = 12 }: { total: number; size?: number }) {
  const [params, setParams] = useSearchParams();
  const count = Math.max(1, Math.ceil(total / size));
  const page = Math.min(count, Math.max(1, Number(params.get('page')) || 1));
  const go = (value: number) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set('page', String(value));
      return next;
    });
  if (total <= size) return null;
  return (
    <div className="pagination">
      <span>
        {(page - 1) * size + 1}–{Math.min(page * size, total)} of {total}
      </span>
      <div>
        <IconButton label="Previous page" disabled={page === 1} onClick={() => go(page - 1)}>
          <ChevronLeft size={16} />
        </IconButton>
        <span>
          Page {page} of {count}
        </span>
        <IconButton label="Next page" disabled={page === count} onClick={() => go(page + 1)}>
          <ChevronRight size={16} />
        </IconButton>
      </div>
    </div>
  );
}
export function usePage<T>(values: T[], size = 12) {
  const [params] = useSearchParams();
  const page = Math.min(
    Math.max(1, Math.ceil(values.length / size)),
    Math.max(1, Number(params.get('page')) || 1),
  );
  return values.slice((page - 1) * size, page * size);
}
export function Cached({ repository }: { repository: RepositoryRecord }) {
  return (
    <span className="cached" title={dateLabel(repository.syncedAt)}>
      <Clock3 size={11} />
      Cached {relative(repository.syncedAt)}
    </span>
  );
}
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className={`dialog-content ${wide ? 'dialog-wide' : ''}`}>
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Description>{description}</Dialog.Description>
          <Dialog.Close asChild>
            <IconButton label="Close dialog">
              <X size={18} />
            </IconButton>
          </Dialog.Close>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function FindingRows({
  findings,
  compact = false,
}: {
  findings: Finding[];
  compact?: boolean;
}) {
  const { inspect } = useApp();
  return (
    <div className="finding-list">
      {findings.map((finding) => (
        <button
          className={`finding-row ${compact ? 'compact' : ''}`}
          key={finding.id}
          onClick={() => inspect(finding.id)}
        >
          <span className={`severity-marker severity-${finding.severity}`} />
          <div className="finding-main">
            <div className="finding-title">{finding.title}</div>
            <div className="finding-meta">
              <span>{finding.repository}</span>
              <span>{finding.type.replaceAll('_', ' ')}</span>
              <span>{relative(finding.lastObservedAt)}</span>
            </div>
          </div>
          <div className="finding-trailing">
            <Badge tone={finding.severity}>{finding.severity}</Badge>
            <span className="confidence">{finding.confidence.replaceAll('_', ' ')}</span>
          </div>
          <ChevronRight size={16} />
        </button>
      ))}
    </div>
  );
}
export function FindingDialog({
  finding,
  close,
}: {
  finding: Finding | undefined;
  close: () => void;
}) {
  const { busy, mutate, data } = useApp();
  return (
    <Modal
      open={Boolean(finding)}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={finding?.title ?? 'Finding'}
      description="An evidence-backed diagnostic, with its certainty and observation history."
      wide
    >
      {finding && (
        <>
          <div className="inline-meta">
            <Badge tone={finding.severity}>{finding.severity}</Badge>
            <Badge>{finding.confidence.replaceAll('_', ' ')}</Badge>
            <Status value={finding.status} />
            <Link to={repositoryHref(finding.repository)} onClick={close}>
              {finding.repository}
            </Link>
          </div>
          <div className="evidence-section">
            <h3>What we observed</h3>
            <p>{finding.explanation}</p>
          </div>
          <div className="evidence-section">
            <h3>Supporting evidence</h3>
            <dl className="evidence-list">
              {finding.evidence.map((evidence, index) => (
                <div key={index}>
                  <dt>{evidence.label}</dt>
                  <dd>
                    {evidence.url ? (
                      <ExternalLink href={evidence.url}>{evidence.value}</ExternalLink>
                    ) : (
                      evidence.value
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="recommendation">
            <ShieldCheck size={19} />
            <div>
              <h3>Recommended next step</h3>
              <p>{finding.recommendation}</p>
            </div>
          </div>
          <dl className="observation-meta">
            <div>
              <dt>First detected</dt>
              <dd>{dateLabel(finding.firstDetectedAt)}</dd>
            </div>
            <div>
              <dt>Last observed</dt>
              <dd>{dateLabel(finding.lastObservedAt)}</dd>
            </div>
            <div>
              <dt>Rule</dt>
              <dd className="mono">
                {finding.ruleId} · v{finding.ruleVersion}
              </dd>
            </div>
          </dl>
          <div className="dialog-actions finding-actions">
            <label>
              Status
              <select
                aria-label="Finding status"
                value={finding.status}
                disabled={busy}
                onChange={(event) =>
                  void mutate(
                    `/api/findings/${encodeURIComponent(finding.id)}`,
                    { status: event.target.value as FindingStatus },
                    'Finding status updated',
                    'PATCH',
                  )
                }
              >
                {['new', 'resolved'].includes(finding.status) && (
                  <option disabled value={finding.status}>
                    {finding.status} (automatic)
                  </option>
                )}
                {['active', 'acknowledged', 'suppressed'].map((status) => (
                  <option key={status}>{status}</option>
                ))}
              </select>
            </label>
            <div>
              {finding.resourceUrl && (
                <ExternalLink className="button" href={finding.resourceUrl}>
                  View on GitHub
                </ExternalLink>
              )}
              {finding.safeAction && (
                <Link
                  className="button primary"
                  to={`/safe-actions?repo=${encodeURIComponent(finding.repository)}`}
                  onClick={close}
                >
                  Review safe actions
                </Link>
              )}
              <button
                className="button"
                disabled={busy || data.settings.suppressedRules.includes(finding.ruleId)}
                onClick={() =>
                  void mutate(
                    '/api/settings',
                    {
                      ...data.settings,
                      suppressedRules: [
                        ...new Set([...data.settings.suppressedRules, finding.ruleId]),
                      ],
                    },
                    'Rule suppressed for this workspace',
                    'PUT',
                  )
                }
              >
                Suppress rule
              </button>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}
export function Notifications({ open, close }: { open: boolean; close: () => void }) {
  const { data, busy, mutate, inspect } = useApp();
  return (
    <Modal
      open={open}
      onOpenChange={(value) => {
        if (!value) close();
      }}
      title="Notifications"
      description="New diagnostic findings in the current workspace."
    >
      {data.notifications.length ? (
        <div className="notification-list">
          {data.notifications.map((notification) => (
            <div
              className={`notification ${notification.read ? 'is-read' : ''}`}
              key={notification.id}
            >
              <CircleDot size={15} />
              <button
                onClick={() => {
                  inspect(notification.findingId);
                  close();
                }}
              >
                <strong>{notification.title}</strong>
                <span>{relative(notification.createdAt)}</span>
              </button>
              <IconButton
                label={notification.read ? 'Notification read' : 'Mark notification read'}
                disabled={busy || notification.read}
                onClick={() =>
                  void mutate(
                    `/api/notifications/${encodeURIComponent(notification.id)}/read`,
                    {},
                    'Notification marked as read',
                  )
                }
              >
                {notification.read ? <CheckCheck size={17} /> : <Check size={17} />}
              </IconButton>
            </div>
          ))}
        </div>
      ) : (
        <Empty title="You're all caught up">
          New findings will appear here when notifications are enabled.
        </Empty>
      )}
    </Modal>
  );
}
export function BusyLabel({ children, busy }: { children: ReactNode; busy: boolean }) {
  return (
    <>
      {busy ? <LoaderCircle className="spin" size={15} /> : null}
      {children}
    </>
  );
}
export function SortIcon({ direction }: { direction: string }) {
  return direction === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />;
}
export function PullRequestIcon() {
  return <GitPullRequest size={17} />;
}
export function FindingsEmpty() {
  const { data } = useApp();
  const observed = data.repositories.some((r) => Boolean(r.syncedAt));
  return (
    <Empty
      title={observed ? 'No findings match this view' : 'No diagnostic evidence yet'}
      icon={<ShieldCheck size={25} />}
    >
      {observed
        ? 'Adjust your filters or synchronize to check for new observations.'
        : 'Add a repository and synchronize it to evaluate pull requests, workflows, storage, and configuration.'}
    </Empty>
  );
}
export function FindingSummary({ repository }: { repository: string }) {
  const { data } = useApp();
  const count = data.findings.filter((f) => f.repository === repository && unresolved(f)).length;
  return count ? (
    <Badge tone="medium">
      {count} finding{count !== 1 ? 's' : ''}
    </Badge>
  ) : (
    <span className="muted">No open findings</span>
  );
}
