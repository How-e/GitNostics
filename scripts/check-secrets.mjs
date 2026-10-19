import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

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
for (const file of new Set(files)) {
  const stat = statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) continue;
  if (
    /(?:^|\/)\.env(?:\..+)?$|\.(?:pem|key|p12|pfx)$/iu.test(file) &&
    !file.endsWith('.env.example')
  ) {
    console.error(`Credential/configuration file must not be committed: ${file}`);
    failures += 1;
    continue;
  }
  if (stat.size > 2 * 1024 * 1024) {
    if (!/(?:^|\/)pnpm-lock\.yaml$/u.test(file)) {
      console.error(`Secret check cannot inspect oversized file: ${file}`);
      failures += 1;
    }
    continue;
  }
  const content = readFileSync(file, 'utf8');
  if (content.includes('\0')) continue;
  for (const [label, expression] of checks) {
    if (expression.test(content)) {
      console.error(`Potential ${label} in ${file}`);
      failures += 1;
    }
  }
}
if (failures > 0) {
  console.error(
    `Secret checks failed (${failures} finding(s)); inspect locally without copying secrets.`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `Secret checks passed (${new Set(files).size} repository files; heuristic patterns only).`,
  );
}
