# Publication privacy checklist

Upload through Git from this checkout. Do not upload a ZIP or drag the working directory into GitHub: those methods can include ignored local data.

Local pre-commit and pre-push hooks run the privacy checker in this checkout. To enable the same guards in a fresh clone, run `git config --local core.hooksPath .githooks`. Hooks require Node on PATH. Hooks can be bypassed and are not a security boundary; keep the manual review below and GitHub secret scanning/push protection where available.

## Excluded local material

Git and Docker exclusions cover local environment configuration (except the blank `.env.example` template), private keys/certificate bundles, credential files, runtime databases and WAL files, data and backup directories, screenshots, recordings, local reports, logs, network captures, archives, build output, dependencies, caches, editor settings, and local Compose overrides. Keep downloaded workflow logs and other private evidence under `.local/`; keep GitHub App keys outside the repository. Custom data paths must also be outside the checkout or explicitly ignored before use.

`.env.example`, source fixtures, public documentation, migrations, CI configuration, and the dependency lockfile are intentional publication content. Demo repositories and test identifiers are synthetic. Do not add real repository snapshots or credentials to fixtures.

## Run before upload

```sh
node --test scripts/check-secrets.spec.mjs
node scripts/check-secrets.mjs
git status --short
git diff --cached --stat
```

The privacy checker examines non-ignored working files, the staged index, and file content in every commit reachable from local refs. It rejects prohibited private/generated paths, unsupported binary entries and common credential patterns. It prints file paths and rule labels, never matched credential values. Any unexpected error is a failed check. Rerun after staging the final changes and before every push; CI also runs the check, but cannot prevent the initial upload.

Inspect the staged diff locally before committing. Never force-add ignored files. Ignore rules cannot remove previously committed files or sanitize history. The checker is heuristic, not proof that arbitrary text contains no private information. It does not inspect ignored local files, external directories, Git LFS payloads, unreachable Git objects, or remote-only history. Non-regular Git entries are rejected rather than silently skipped.

## Commit identity and historical disclosures

Git publishes author/committer names, email addresses, commit messages, and tag metadata. Review these locally before publishing; do not paste private values into reports. Use an approved GitHub noreply email or generic project attribution when personal attribution is unwanted. Changing Git configuration only affects future commits; old metadata needs a separately authorized history rewrite. A history rewrite changes commit IDs and requires coordination if already shared. Review configured remote URLs for embedded credentials and use credential-free URLs.

Before initial publication, the operator approved replacing the initial commit's author/committer identity with `GitNostics contributors <contributors@example.invalid>` and setting that repository-local identity for future commits. The old commit remains only in local recovery history, which a normal Git push does not upload; do not publish a raw `.git` directory. The generic commit email is not a working support contact. Configure and verify a reachable support address separately; see [integration readiness](INTEGRATION_READINESS.md).

If a secret was committed, revoke/rotate it first and sanitize the reachable history before upload. Removing the file or adding an ignore rule alone is insufficient. Do not push a detected disclosure merely to see whether hosted checks catch it.
