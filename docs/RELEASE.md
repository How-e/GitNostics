# Versioning and release checklist

The root package version identifies the application. Use semantic versioning after the supported first release; before 1.0, document compatibility changes clearly. Database migrations have their own ordered versions and are always additive. A tag or package version is not a release-readiness certificate.

For each proposed release:

Current acceptance scope is local Windows use; M0 is complete by operator confirmation. Linux/Docker, remote TLS hosting and physical mobile gates below apply when those deployment scopes are claimed. Their deferral does not constitute successful verification. Public/private GitHub App access and the documented automated/production checks have operator-reported acceptance; detailed scenarios remain tracked in [implementation status](IMPLEMENTATION_STATUS.md).

- Verify the exact reviewed commit and a clean dependency install using the committed lockfile.
- Run formatting, lint, strict TypeScript, unit/integration suites, production build/startup, browser E2E, secret checks, and a current production dependency audit. Record actual results.
- Require hosted CI checks on the final PR head SHA and an approved review. Do not bypass or weaken branch protections. Recommended required checks are the stable `verify` and `container` job names from CI; configure them only after the workflow has run.
- Validate read-only GitHub App setup/discovery/private access/token renewal/permission failures against authorized repositories. Keep write tests on fake transports; record any separately performed owner-controlled live acceptance without claiming it happened here.
- Verify Windows and Linux startup, Docker health/nonroot permissions/persistent restart, automatic migrations on an existing database, online backup, and a stopped-service restore drill.
- Review desktop, phone/tablet layouts, keyboard navigation, focus, contrast, and screen-reader behavior. Automated viewport checks do not establish physical-device accessibility.
- Compare feature claims with the UI and API. Check data-mode labels, stale/error states, histories, rate limits, bounded resources, and action denial/confirmation/replay behavior.
- Ensure no `.env`, private key, token, runtime DB, screenshot, downloaded log, or local report is staged. Review image build context and browser bundle for accidental secrets.
- Update README, roadmap, implementation status, operator/deployment instructions, and release notes, including exact remaining limitations and any migration/backup requirements.
- Build the Docker image from the reviewed commit. Record base image/digest and dependency lock provenance for reproducibility; floating base tags must be resolved and retained for a published release. Publish only with maintainer authorization and a documented artifact verification step.

Do not publish a release-ready claim while critical functionality or required supported-environment acceptance is unverified. The repository currently includes a build configuration, not an automatic publishing or update service.
