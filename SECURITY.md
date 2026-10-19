# Security policy

GitNostics is an initial implementation. No public release is currently certified as production-ready; [implementation status](docs/IMPLEMENTATION_STATUS.md) records the actual verification boundary. Security fixes target the current development line until a supported-release policy is published.

Please report vulnerabilities privately. Use the repository's **Security → Advisories → Report a vulnerability** option if enabled. Otherwise, contact a maintainer through a private contact method on their GitHub profile; if none is available, request a private reporting channel without including exploit details. Do not open a public issue containing credentials, private repository information, or an active exploit.

Include affected version/commit, deployment model, reproduction steps, impact, and a sanitized proof of concept. Never include real tokens, private keys, raw private workflow logs, or database exports. There is no promised response time or bug bounty.

If a credential may have leaked, revoke or rotate it on GitHub immediately. Remove the affected server configuration and restart GitNostics. Removing a browser connection or local data does not itself revoke a GitHub App installation or key.

For secure configuration, operator authentication, network exposure, permissions, backups, and residual limitations, read [docs/SECURITY.md](docs/SECURITY.md).
