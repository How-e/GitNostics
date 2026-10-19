# Integration readiness

This checklist records evidence for sharing and operating the integration. It is separate from milestone completion and release acceptance. An unchecked item remains open; documentation alone does not complete it. See [implementation status](IMPLEMENTATION_STATUS.md) for executed checks and remaining limits.

## GitHub Developer Program eligibility review

Reviewed on 2026-10-18 against GitHub's [Developer Program requirements](https://docs.github.com/en/integrations/concepts/github-developer-program). GitHub lists an API integration in development or production and an email address for user support. GitNostics supplies a development integration through server-side Octokit/GitHub App authentication, repository discovery, and repository/Actions diagnostics, plus the documented support address [GitNostics@protonmail.com](mailto:GitNostics@protonmail.com). The implementation and documented contact satisfy the published project criteria; mailbox delivery and account registration remain unverified.

GitHub's [profile reference](https://docs.github.com/en/account-and-profile/reference/profile-reference#displaying-badges-on-your-profile) ties the Developer Program Member profile badge to registered membership while building an API application. A repository push, GitHub App registration, or passing tests does not establish that membership. The account owner must [register for the program](https://github.com/developer/register) and confirm the support mailbox works. This review does not claim GitHub approval, enrollment, or an awarded badge. Production release readiness and Marketplace listing are separate assessments; the published program criteria allow integrations still in development.

## Integration and safeguards

- [x] Implement server-side GitHub App installation authentication and supported public API reads.
- [x] Record operator-confirmed production-mode App access to public and private repositories on 2026-10-18. This is operator evidence; it does not attest token renewal, revocation, or every permission-failure scenario.
- [x] Document App registration, selected-repository installation, read permissions, key handling, disconnection, and rotation in [GitHub App setup](GITHUB_APP_SETUP.md).
- [x] Keep fixture data explicitly separate from live repository evidence. Demo actions are simulations.
- [x] Default GitHub writes to disabled; require server opt-in, operator authentication, verified permission, and explicit preview confirmation for supported writes. Never weaken branch protections.
- [x] Provide a [security policy](../SECURITY.md), [security model](SECURITY.md), [data handling notice](PRIVACY.md), and [support guidance](SUPPORT.md).
- [x] Document the maintainer-approved support address [GitNostics@protonmail.com](mailto:GitNostics@protonmail.com) in support guidance and README.
- [x] Supply local privacy guards and a [manual publication review](PUBLICATION_PRIVACY.md). Heuristic scans do not prove arbitrary text is free of sensitive information.
- [x] Configure the credential-free remote `https://github.com/How-e/GitNostics.git`; verify that the intended target is the private `How-e/GitNostics` repository. Repository visibility was not changed. A private repository does not provide an anonymous public project page.

## Operator items still open

- [ ] Confirm receipt at the approved support address from an external sender and configure relevant integration contact settings. The address is approved and documented; external mailbox delivery and receipt have not been verified here. A generic commit identity or `.invalid` address is not a support mailbox.
- [ ] Verify the published README, support/privacy/security links, license, and intended App homepage after upload. The configured private repository requires authorized access; no anonymous public publication or App homepage setting has been verified.
- [ ] Run hosted CI on the reviewed final commit and configure required checks without bypassing or weakening existing branch protection. Supplied workflow files are not successful hosted runs.
- [ ] Record detailed read-only M1 acceptance against an authorized App installation: repository discovery/selection, timestamps and restart persistence, token renewal/recovery, permission loss, and rate-limit/error recovery. Retain sanitized results outside Git. Never send real GitHub mutations to satisfy this checklist.
- [ ] Complete the supported Windows deployment and release checks in [RELEASE.md](RELEASE.md). Docker/Linux, remote hosting, and physical mobile support need their own acceptance before being claimed.

The maintainer operates the published support channel, keeps integration contact information current, reviews dependency/security reports, and handles access revocation and sensitive-data deletion requests. This self-hosted implementation provides no hosted account service, support SLA, automatic publication, or automatic credential revocation.
