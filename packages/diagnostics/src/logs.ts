import { createHash } from 'node:crypto';
import type { FailureSignature, Incident, WorkflowRun } from '@gitnostics/shared';

/** Input is bounded before any pattern processing. No raw logs leave this module. */
export const LOG_LIMITS = Object.freeze({ bytes: 65_536, lines: 500, lineCharacters: 2_000 });

function boundedUtf8(input: string, maximumBytes: number): string {
  const bytes = Buffer.from(input);
  if (bytes.length <= maximumBytes) return input;
  let end = maximumBytes;
  while ((bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

export function fingerprint(...parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function redactLog(input: string): string {
  const prefix = input.slice(0, LOG_LIMITS.bytes + 1);
  const bounded = boundedUtf8(prefix, LOG_LIMITS.bytes);
  // eslint-disable-next-line no-control-regex -- ANSI control sequences are intentionally removed.
  const text = bounded.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  const redacted = text
    // Preserve quoted JSON/curl context while removing every cookie in a header value.
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
    .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '[REDACTED]')
    .replace(/\bAKIA[A-Z0-9]+/g, '[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=:-]+/gi, '$1 [REDACTED]')
    .replace(/\b(authorization|proxy-authorization|x-api-key)\s*:\s*[^\r\n]+/gi, '$1: [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(
      /(\b(?:[A-Za-z][A-Za-z0-9_]*_)?(?:token|api[_-]?key|secret|password|passwd|client[_-]?secret|access[_-]?token|authorization|private[_-]?key|aws[_-]?secret[_-]?access[_-]?key)\b["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*"?|'(?:\\.|[^'\\\r\n])*'?|[^\s,;&]+)/gi,
      '$1[REDACTED]',
    )
    .replace(
      /([?&](?:sig|signature|access_token|token|key|credential|x-amz-[a-z-]+)=)[^&\s]+/gi,
      '$1[REDACTED]',
    )
    .split('\n')
    // Persisted GitHub excerpts already contain the tail. Keep terminal errors
    // after redacting the entire bounded input, including multiline secrets.
    .slice(-LOG_LIMITS.lines)
    .map((line) => line.slice(0, LOG_LIMITS.lineCharacters))
    .join('\n');
  return boundedUtf8(redacted, LOG_LIMITS.bytes);
}

export function normalizeFailureSignature(line: string): string {
  return redactLog(line)
    .replace(/^\s*(?:\d{4}-\d\d-\d\d[T ][\d:.+-]+Z?\s*)?/g, '')
    .replace(/##\[(?:error|warning|group|endgroup)\]/gi, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b[0-9a-f]{7,64}\b/gi, '<hash>')
    .replace(/(?:[A-Za-z]:\\|\/(?:home|Users|tmp|var|workspace|opt)\/)[^\s"'<>]+/g, '<path>')
    .replace(/:\d+(?::\d+)?\b/g, ':<line>')
    .replace(
      /\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|seconds?|secs?|minutes?|mins?)\b/gi,
      '<duration>',
    )
    .replace(/\b(?:run|job|process|pid|attempt)\s*(?:#|:|=)?\s*\d+\b/gi, '<execution>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 600);
}

const classifiers: ReadonlyArray<{ category: string; pattern: RegExp }> = [
  {
    category: 'out_of_memory',
    pattern:
      /out of memory|heap limit|heap out of memory|oom(?:killed| killer)|cannot allocate memory|killed process.*memory|exit(?:ed)?(?: with)? (?:code )?137\b/i,
  },
  {
    category: 'missing_dependency',
    pattern:
      /cannot find (?:module|package)|modulenotfounderror|no module named|module not found|command not found|could not find a version that satisfies|no matching distribution found/i,
  },
  {
    category: 'authentication',
    pattern:
      /bad credentials|authentication (?:failed|required)|permission denied|resource not accessible|unauthori[sz]ed|\b403\b.*forbidden|\b401\b.*(?:error|http)|invalid (?:access )?token/i,
  },
  {
    category: 'timeout',
    pattern:
      /timed? ?out|timeout(?:error| exceeded| of| after)|deadline exceeded|maximum execution time/i,
  },
  {
    category: 'network',
    pattern:
      /econnreset|econnrefused|enotfound|eai_again|socket hang up|network (?:error|unreachable)|temporary failure in name resolution|\b50[234]\b.*(?:gateway|unavailable)|could not resolve host/i,
  },
  {
    category: 'test_assertion',
    pattern:
      /assertionerror|assertion failed|assert(?:\.equal|\.strictEqual|ion)?[^(\n]*\(.*failed|expected .*(?:received|to (?:be|equal|match))|\bFAIL\s+.*(?:test|spec)|tests? failed/i,
  },
  {
    category: 'configuration',
    pattern:
      /invalid (?:workflow|configuration|config|yaml)|yaml(?:exception|error)|error parsing (?:workflow|yaml|configuration)|required (?:input|environment variable).*missing|unexpected (?:input|value).*workflow/i,
  },
  {
    category: 'compilation',
    pattern:
      /error TS\d+|\bTS\d{4}:|compilation failed|compile error|build failed|failed to compile|syntaxerror:|(?:fatal )?error:.*(?:undeclared|undefined reference|no such file)/i,
  },
  {
    category: 'dependency_installation',
    pattern:
      /npm (?:ERR!|error)|ERR_PNPM_|yarn (?:error|install.*failed)|pip.*(?:install|resolution).*failed|eresolve|unable to resolve dependency tree|dependency resolution failed|package installation failed|integrity checksum failed|lockfile.*(?:out of date|not up.to.date|broken)/i,
  },
];

export function classifyFailure(log: string): FailureSignature {
  const excerpt = redactLog(log);
  const lines = excerpt.split('\n');
  for (const { category, pattern } of classifiers) {
    const line = lines.find((candidate) => pattern.test(candidate));
    if (line) {
      const signature = normalizeFailureSignature(line);
      return {
        category,
        signature,
        fingerprint: fingerprint('failure-v1', category, signature),
        excerpt,
        confidence: 'probable',
      };
    }
  }
  const candidate =
    lines.find((line) => /error|failed|fatal|exception/i.test(line)) ??
    lines.find((line) => line.trim()) ??
    'No bounded log evidence available';
  const signature = normalizeFailureSignature(candidate);
  return {
    category: 'unknown',
    signature,
    fingerprint: fingerprint('failure-v1', 'unknown', signature),
    excerpt,
    confidence: 'insufficient_evidence',
  };
}

export function correlateFailures(runs: WorkflowRun[]): Incident[] {
  const groups = new Map<string, Incident>();
  for (const run of runs) {
    if (
      !['failure', 'timed_out', 'startup_failure', 'action_required'].includes(run.conclusion ?? '')
    )
      continue;
    for (const job of run.jobs) {
      if (
        !['failure', 'timed_out', 'startup_failure', 'action_required'].includes(
          job.conclusion ?? '',
        ) ||
        !job.logExcerpt
      )
        continue;
      const result = classifyFailure(job.logExcerpt);
      // Unknown output does not establish a shared underlying cause.
      if (result.category === 'unknown') continue;
      let group = groups.get(result.fingerprint);
      if (!group) {
        group = {
          fingerprint: result.fingerprint,
          category: result.category,
          signature: result.signature,
          count: 0,
          firstSeen: run.createdAt,
          lastSeen: run.createdAt,
          runs: [],
        };
        groups.set(result.fingerprint, group);
      }
      if (run.createdAt < group.firstSeen) group.firstSeen = run.createdAt;
      if (run.createdAt > group.lastSeen) group.lastSeen = run.createdAt;
      if (!group.runs.some((reference) => reference.id === run.id)) group.count += 1;
      if (!group.runs.some((reference) => reference.id === run.id && reference.job === job.name)) {
        group.runs.push({ id: run.id, url: job.url || run.url, name: run.name, job: job.name });
      }
    }
  }
  return [...groups.values()].sort(
    (a, b) => b.count - a.count || a.fingerprint.localeCompare(b.fingerprint),
  );
}
