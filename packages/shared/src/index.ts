import { z } from 'zod';

export const repoNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  .max(201)
  .refine(
    (value) => value.split('/').every((part) => part !== '.' && part !== '..'),
    'Invalid repository path: segments cannot be dot-only.',
  );
export const modeSchema = z.enum(['demo', 'live']);
export type DataMode = z.infer<typeof modeSchema>;
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type Confidence = 'confirmed' | 'probable' | 'insufficient_evidence';
export type FindingStatus = 'new' | 'active' | 'acknowledged' | 'resolved' | 'suppressed';
export interface Evidence {
  label: string;
  value: string;
  url?: string;
}
export interface FindingInput {
  ruleId: string;
  ruleVersion: number;
  fingerprint: string;
  repository: string;
  type: 'pull_request' | 'workflow' | 'configuration' | 'storage';
  severity: Severity;
  confidence: Confidence;
  title: string;
  explanation: string;
  recommendation: string;
  evidence: Evidence[];
  resourceUrl?: string;
  safeAction?: ActionKind;
}
export interface Finding extends FindingInput {
  id: string;
  mode: DataMode;
  status: FindingStatus;
  firstDetectedAt: string;
  lastObservedAt: string;
  resolvedAt?: string;
}
export interface Check {
  name: string;
  status: 'success' | 'failure' | 'pending' | 'skipped' | 'neutral';
  url?: string;
  appId?: number;
}
export interface PullRequest {
  number: number;
  title: string;
  author: string;
  url: string;
  headSha: string;
  baseBranch: string;
  draft: boolean;
  mergeable: boolean | null;
  mergeableState: string;
  checks: Check[];
  approvals: number;
  changesRequested: boolean;
  updatedAt: string;
  requiredChecks?: string[];
  requiredCheckSources?: { name: string; appId?: number }[];
  requiredApprovals?: number;
  requiresCodeOwnerReview?: boolean;
  protectionKnown: boolean;
  checksComplete?: boolean;
  reviewDecision?: string;
  behindBy?: number;
  workflowPathFilters?: string[];
}
export interface WorkflowJob {
  id: number;
  name: string;
  conclusion: string | null;
  url: string;
  startedAt?: string;
  completedAt?: string;
  logExcerpt?: string;
}
export interface WorkflowRun {
  id: number;
  workflowId: number;
  name: string;
  title: string;
  branch: string;
  event: string;
  status: string;
  conclusion: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
  durationSeconds: number;
  attempt: number;
  jobs: WorkflowJob[];
}
export interface Artifact {
  id: number;
  name: string;
  sizeBytes: number;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
  runId?: number;
}
export type ConfigValue = string | number | boolean | string[] | null;
export interface RepositoryConfig {
  values: Record<string, ConfigValue>;
  inaccessible: string[];
}
export interface RepositoryIssue {
  number: number;
  title: string;
  state: string;
  author: string;
  url: string;
  updatedAt: string;
}
export interface RepositoryBranch {
  name: string;
  protected: boolean;
  sha: string;
}
export interface RepositoryCommit {
  sha: string;
  message: string;
  author: string;
  url: string;
  committedAt: string;
}
export interface RepositorySnapshot {
  fullName: string;
  name: string;
  owner: string;
  description: string;
  url: string;
  private: boolean;
  defaultBranch: string;
  language: string | null;
  stars: number;
  openIssues: number;
  updatedAt: string;
  permissions: {
    actions: 'read' | 'write' | 'unknown';
    administration: 'read' | 'write' | 'unknown';
  };
  pullRequests: PullRequest[];
  runs: WorkflowRun[];
  artifacts: Artifact[];
  config: RepositoryConfig;
  cacheBytes?: number;
  warnings: string[];
  collectionState?: { pullRequests: boolean; runs: boolean; artifacts: boolean; config: boolean };
  recentIssues?: RepositoryIssue[];
  branches?: RepositoryBranch[];
  recentCommits?: RepositoryCommit[];
}
export interface RepositoryRecord {
  fullName: string;
  mode: DataMode;
  favorite: boolean;
  selected: boolean;
  syncedAt: string | null;
  syncStatus: 'idle' | 'queued' | 'syncing' | 'error';
  error: string | null;
  snapshot: RepositorySnapshot | null;
}
export interface FailureSignature {
  category: string;
  fingerprint: string;
  signature: string;
  excerpt: string;
  confidence: Confidence;
}
export interface Incident {
  fingerprint: string;
  category: string;
  signature: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  runs: { id: number; url: string; name: string; job: string }[];
}
export type ActionKind = 'rerun_failed' | 'rerun' | 'delete_artifacts' | 'dispatch';
export const actionRequestSchema = z
  .object({
    repository: repoNameSchema,
    kind: z.enum(['rerun_failed', 'rerun', 'delete_artifacts', 'dispatch']),
    runId: z.number().int().positive().optional(),
    artifactIds: z.array(z.number().int().positive()).min(1).max(100).optional(),
    workflowId: z.number().int().positive().optional(),
    ref: z.string().min(1).max(255).optional(),
  })
  .strict();
export type ActionRequest = z.infer<typeof actionRequestSchema>;
export interface ActionPreview {
  id: string;
  mode: DataMode;
  request: ActionRequest;
  title: string;
  impact: string[];
  destructive: boolean;
  allowed: boolean;
  reason?: string;
  expiresAt: string;
  confirmation: string;
}
export interface AuditEvent {
  id: string;
  mode: DataMode;
  kind: string;
  repository?: string;
  message: string;
  createdAt: string;
}
export interface Notification {
  id: string;
  mode: DataMode;
  findingId: string;
  title: string;
  read: boolean;
  createdAt: string;
}
export interface AppSettings {
  theme: 'dark' | 'light' | 'system';
  syncIntervalMinutes: number;
  retentionDays: number;
  artifactAgeDays: number;
  notificationsEnabled: boolean;
  minimumSeverity: Severity;
  suppressedRules: string[];
}
export const settingsSchema = z
  .object({
    theme: z.enum(['dark', 'light', 'system']),
    syncIntervalMinutes: z
      .number()
      .int()
      .min(0)
      .max(1440)
      .refine((v) => v === 0 || v >= 5, 'Use 0 or at least 5 minutes'),
    retentionDays: z.number().int().min(7).max(365),
    artifactAgeDays: z.number().int().min(1).max(365),
    notificationsEnabled: z.boolean(),
    minimumSeverity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
    suppressedRules: z.array(z.string().max(100)).max(100),
  })
  .strict();
export const defaultSettings: AppSettings = {
  theme: 'dark',
  syncIntervalMinutes: 0,
  retentionDays: 90,
  artifactAgeDays: 30,
  notificationsEnabled: true,
  minimumSeverity: 'low',
  suppressedRules: [],
};
export interface ConnectionStatus {
  mode: 'public' | 'app' | 'development_pat';
  connected: boolean;
  identity: string;
  writesEnabled: boolean;
  error?: string;
  rateLimit?: { remaining: number; limit: number; resetAt: string };
}
export interface WorkflowPerformance {
  repository: string;
  workflowId: number;
  name: string;
  totalRuns: number;
  failedRuns: number;
  successRate: number | null;
  averageDurationSeconds: number | null;
  recentRegression: boolean;
  repeatedFailingJobs: { name: string; failures: number }[];
  rerunCount: number;
}
export interface Dashboard {
  mode: DataMode;
  repositories: RepositoryRecord[];
  findings: Finding[];
  activity: AuditEvent[];
  incidents: Incident[];
  notifications: Notification[];
  settings: AppSettings;
  connection: ConnectionStatus;
  storageHistory: { repository: string; capturedAt: string; bytes: number }[];
  workflowAnalytics: WorkflowPerformance[];
}
export interface AIProvider {
  readonly id: string;
  summarize(input: {
    redactedText: string;
    consent: true;
    signal?: AbortSignal;
  }): Promise<{ text: string; provenance: 'ai'; provider: string }>;
}
export interface NotificationProvider {
  readonly id: string;
  deliver(notification: Notification): Promise<void>;
}
export const severityWeight: Record<Severity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};
export const bytesLabel = (bytes: number): string =>
  bytes >= 1073741824
    ? `${(bytes / 1073741824).toFixed(1)} GB`
    : bytes >= 1048576
      ? `${(bytes / 1048576).toFixed(1)} MB`
      : `${Math.round(bytes / 1024)} KB`;
