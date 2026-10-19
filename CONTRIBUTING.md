# Contributing

GitNostics welcomes focused bug fixes, reproducible diagnostic rules, accessibility improvements, and documentation corrections. Discuss major changes in an issue before implementation. Follow [AGENTS.md](AGENTS.md), the [architecture](docs/ARCHITECTURE.md), and the [code of conduct](CODE_OF_CONDUCT.md).

Use Node.js 24.13+ and the pnpm version pinned by `packageManager`. Run `pnpm install --frozen-lockfile`, then `pnpm dev`. See [development](docs/DEVELOPMENT.md) for configuration and verification.

Before opening a pull request:

1. Add focused tests for changed rules, permissions, lifecycle behavior, or API contracts. Use synthetic or sanitized fixtures with provenance.
2. Run `pnpm check`, `pnpm test:e2e`, `node scripts/check-secrets.mjs`, and `pnpm audit --prod --audit-level high` as relevant. State exactly which checks ran and their results.
3. Update affected documentation and the implementation status. Describe unsupported or unverified behavior plainly.
4. Keep migrations additive and versioned. Never modify a previously shipped migration to alter an existing database.
5. Keep changes scoped. Do not commit `.env`, private keys, tokens, runtime databases, local reports, browser captures, or downloaded workflow logs.

No test or development verification may mutate GitHub repositories. Use fake transports for write-path tests. New mutation capabilities need narrow input validation, explicit server opt-in, operator authentication, verified GitHub permissions, a reviewable impact preview, confirmation, and audit outcomes. Never weaken repository protections.

Diagnostics must distinguish `confirmed`, `probable`, and `insufficient_evidence`. Missing permission is missing evidence, not a security regression. Demo data must stay labeled and isolated from live records.

PR descriptions should explain the concrete problem, resulting behavior, evidence, checks, and remaining limitations. Maintainers should require passing CI on the final PR commit, review changes to workflows/dependencies/permissions, and merge through the repository's protected-branch process. Local verification does not prove hosted checks passed.

Contributions are licensed under the repository's MIT License.
