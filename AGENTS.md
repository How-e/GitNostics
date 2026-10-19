# GitNostics engineering instructions

Implement the attached brief in dependency order. Keep facts and demo data separate. Never call GitHub mutations in tests or development verification. No credentials in client bundles, logs, fixtures, or Git. Keep mutation routes closed unless server opt-in and operator authentication are both present. Never weaken branch protections.

Use TypeScript with strict checking, Fastify, React/Vite, SQLite, pnpm. Root owns dependency versions and shared contracts. Run relevant unit/integration tests and typecheck/build. Record acceptance limits honestly in docs/IMPLEMENTATION_STATUS.md. Migrations are additive/versioned. Do not commit runtime databases, screenshots, or local reports.

Parallel agent work is authorized. Coordinate ownership: primary owns root tooling, shared types, HTTP API, sync orchestration, integration and final verification. Dedicated agents may own packages/github, packages/diagnostics, apps/server/src/db, apps/web, docs and infrastructure, or bounded security review. Do not alter another agent's files without coordination.
