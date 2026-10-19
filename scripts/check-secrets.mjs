import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';

// Intentionally heuristic: this never prints a matched credential value.
const checks = [
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{40,}\b/u],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u],
  [
    'private key material',
    new RegExp(
      [
        '-----BEGIN ',
        '(?:RSA |EC |OPENSSH |ENCRYPTED )?',
        'PRIVATE KEY-----',
        String.raw`(?:\r?\n|\\n)(?:[A-Za-z0-9+/=]{32,}(?:\r?\n|\\n)){2,}`,
      ].join(''),
      'u',
    ),
  ],
];

const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  },
)
  .split('\0')
  .filter(Boolean);
let failures = 0;
const forbiddenPath =
  /(?:^|\/)(?:\.env(?:\..+)?|\.npmrc|\.?netrc|_netrc|\.git-credentials|id_rsa|id_ed25519|(?:docker-)?compose\.override\.ya?ml)$|(?:^|\/)(?:data|backups|secrets|private|screenshots|recordings|local-reports|node_modules|dist|coverage|test-results|playwright-report|\.local|\.playwright-mcp|\.idea|\.vscode|\.cache|\.pnpm-store|\.vite)(?:\/|$)|\.(?:pem|key|p12|pfx|p8|der|jks|keystore|sqlite(?:-.*)?|db(?:-.*)?|zip|7z|tar|tar\.gz|tgz|bak|dump|sql|har|trace|log|tsbuildinfo|tmp|temp)$/iu;
function inspect(file, content, source) {
  const label = `${source}: ${file}`;
  if (forbiddenPath.test(file) && file !== '.env.example') {
    console.error(`Private/generated file must not be committed (${label})`);
    failures += 1;
    return;
  }
  if (content.length > 2 * 1024 * 1024) {
    if (!/(?:^|\/)pnpm-lock\.yaml$/u.test(file)) {
      console.error(`Secret check cannot inspect oversized file (${label})`);
      failures += 1;
    }
    return;
  }
  if (content.includes(0)) {
    console.error(`Secret check cannot inspect binary file (${label})`);
    failures += 1;
    return;
  }
  const value = content.toString('utf8');
  for (const [label, expression] of checks) {
    if (expression.test(value)) {
      console.error(`Potential ${label} in ${source}: ${file}`);
      failures += 1;
    }
  }
}
for (const file of new Set(files)) {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) {
    console.error(`Secret check cannot inspect symbolic link: ${file}`);
    failures += 1;
    continue;
  }
  if (stat?.isFile()) inspect(file, readFileSync(file), 'working tree');
}

// Check the index independently: the staged version may differ from disk.
// Also inspect every reachable commit; ignoring a previously committed file does
// not remove it from an upload. Never print blob contents or identity metadata.
const git = (args) => {
  try {
    return execFileSync('git', args, {
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    // Child-process errors may include captured blob bytes: do not rethrow them.
    throw new Error('Git privacy inspection failed; inspect repository access and size locally.');
  }
};
const seen = new Set();
function inspectEntry(entry, source) {
  const separator = entry.indexOf('\t');
  const metadata = entry.slice(0, separator).split(' ');
  const file = entry.slice(separator + 1);
  const hash = metadata[1] === 'blob' ? metadata[2] : metadata[1];
  const key = `${hash}:${file}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (metadata[0] !== '100644' && metadata[0] !== '100755') {
    console.error(`Secret check cannot inspect non-regular Git entry (${source}: ${file})`);
    failures += 1;
    return;
  }
  inspect(file, git(['cat-file', 'blob', hash]), source);
}
for (const entry of git(['ls-files', '--stage', '-z'])
  .toString('utf8')
  .split('\0')
  .filter(Boolean)) {
  inspectEntry(entry, 'index');
}
const commits = git(['rev-list', '--all']).toString('utf8').trim().split(/\s+/u).filter(Boolean);
for (const commit of commits) {
  for (const entry of git(['ls-tree', '-r', '-z', commit])
    .toString('utf8')
    .split('\0')
    .filter(Boolean)) {
    inspectEntry(entry, `history ${commit.slice(0, 12)}`);
  }
}
if (failures > 0) {
  console.error(
    `Secret checks failed (${failures} finding(s)); inspect locally without copying secrets.`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `Secret checks passed (${new Set(files).size} repository files, index and ${commits.length} reachable commit(s); heuristic patterns only; commit identity metadata requires separate review).`,
  );
}
