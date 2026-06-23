# Security Policy

## Dependency Audit Policy

The required `Dependency Audit Gate` check runs `npm audit` through
`scripts/run-npm-audit.js`, which reads `audit-policy.jsonc` and audits the full
npm dependency tree, including development and release tooling. The required
`VS Code Extension Tests` check is a separate unprivileged `pull_request` job
that checks out the PR head and runs lifecycle-disabled install, compile, lint,
and `xvfb-run -a npm test` against PR code. The release workflow runs the same
advisory gate before building and packaging the VSIX.

The required test check, release workflow, and pull-request build/documentation
workflows install dependencies with `npm ci --ignore-scripts`, so package
lifecycle scripts cannot run during dependency installation. Install steps also
pin npm to the public registry and ignore repo/user/global npm config so a pull
request cannot redirect package resolution through `.npmrc`.

## Required Check Rollout

Branch protection must require the exact `Dependency Audit Gate` and
`VS Code Extension Tests` contexts when this audit-gate rollout merges. The
`Dependency Audit Gate` context is produced by `.github/workflows/test.yml` from
the protected base branch, and `VS Code Extension Tests` is produced by
`.github/workflows/pr-tests.yml` from unprivileged `pull_request` events.

At merge time, maintainers must update branch protection in the same deployment
window: add `Dependency Audit Gate`, keep `VS Code Extension Tests`, and remove
any retired workflow-specific test context only after confirming both current
contexts report on a fresh PR. Pull requests that were opened before this
rollout and do not contain `.github/workflows/pr-tests.yml` must be rebased onto
`main` after the rollout, or maintainers must temporarily allow the previous
test context until those PRs are rebased. Do not pre-require
`Dependency Audit Gate` before this workflow has landed on `main`.

The advisory and signature gates pin npm operations to
`https://registry.npmjs.org/` and ignore user/global npm config so a repository
or user `.npmrc` cannot redirect audit results or signature metadata to another
registry.

`npm-shrinkwrap.json` is not supported. npm gives shrinkwrap files precedence
over `package-lock.json`, so a shrinkwrap-only dependency tree could differ
from the audited lockfile. Pull-request metadata download, policy guardrails,
and `scripts/run-npm-audit.js` reject shrinkwrap files fail-closed.

## PR Audit Metadata Limits

The privileged pull-request audit downloads only the metadata files below from
the PR head, and it rejects files whose declared or decoded size exceeds the
documented cap before writing them into the audit workspace.

| Metadata file                           |     Cap |
| --------------------------------------- | ------: |
| `.github/CODEOWNERS`                    |  64 KiB |
| `.github/workflows/build-extension.yml` | 256 KiB |
| `.github/workflows/code-quality.yml`    | 256 KiB |
| `.github/workflows/docs.yml`            | 256 KiB |
| `.github/workflows/pr-tests.yml`        | 256 KiB |
| `.github/workflows/release.yml`         | 256 KiB |
| `.github/workflows/test.yml`            | 256 KiB |
| `audit-policy.jsonc`                    |  64 KiB |
| `package.json`                          | 256 KiB |
| `package-lock.json`                     |   5 MiB |

`npm-shrinkwrap.json` and `.npmrc` remain unsupported PR metadata because they
can change the audited dependency tree or npm configuration.

The gate fails on moderate, high, or critical advisories because tooling
dependencies participate in building, packaging, and testing the VSIX.
Low-severity advisories are triaged through Dependabot updates and can be
checked locally with `npm audit --audit-level=low`, but they do not block the
required merge gate.

Runtime-only audits are useful for triage, but they are not the blocking policy
for this repository. Available fixes should be applied by upgrading direct
dependencies, refreshing the lockfile, or replacing vulnerable tooling. CI also
verifies npm registry signatures and attestations with `npm audit signatures`.
The privileged pull-request audit gate does not install PR dependencies;
signature verification runs on release and unprivileged build workflows instead.
If signature verification fails because a legitimate transitive package is
unsigned, treat it as a supply-chain exception: open a tracking issue with owner
and review date, then use the accepted-advisory process only when the release or
merge cannot wait.

## Accepted Advisories And Break-Glass

`audit-policy.jsonc` contains the machine-readable `acceptedAdvisories` list.
The file includes an inline strict-JSON notice because comments and trailing
commas are not accepted despite the `.jsonc` extension.
Each entry must include a GHSA advisory id, package name, owner, reason, and
`reviewBy` date, plus the reviewed package paths where the advisory is accepted.
The policy guard rejects malformed entries, expired entries, entries more than
30 days out, lowered thresholds, skipped dev dependencies, pathless acceptances,
and unknown policy keys. Both the required test check and the release workflow
honor this list, so a tracked no-fix advisory can unblock merges and releases
without turning off the audit gate.

Changes to the policy file, dependency manifests, `.npmrc`, `npm-shrinkwrap.json`,
audit helpers, and audit workflows are listed in `.github/CODEOWNERS`; branch
protection must require CODEOWNER review so a PR cannot introduce a vulnerable
dependency and approve its own accepted-advisory entry. On pull requests, the
required dependency audit check runs from `pull_request_target`, checks out audit
scripts from the protected base branch, downloads only the PR metadata needed
for the dependency gate, and points the trusted scripts at the PR lockfile. The
PR test and build workflows that compile, test, and package PR code run under
unprivileged `pull_request` instead. The audit gate uses the accepted-advisory
list from the protected base branch, so a PR-local exception does not silence a
newly introduced finding until that exception has landed through the protected
policy path.

For emergency or unrelated changes blocked by a new moderate-or-higher advisory
without an available fix:

1. Open a tracking issue that records the package, advisory URL, affected scope,
   owner, reason for acceptance, and review-by date.
2. Add the advisory to `acceptedAdvisories` with the reviewed package paths and
   a review date no later than 30 days out.
3. Merge the policy update through normal review, or use administrator
   branch-protection break-glass only if the emergency cannot wait.
4. Remove, replace, or upgrade the affected dependency before the review date.

For an emergency release blocked by a new advisory, expired acceptance, or npm
registry/advisory outage, maintainers can run the release workflow manually with
`dependency_gate_break_glass` set to a non-empty reason. The release build waits
for the protected `dependency-gate-break-glass` GitHub Environment before
packaging, records the actor and reason in the step summary, and skips only the
dependency advisory gates for that `workflow_dispatch` run. Signature
verification still runs because it detects package integrity problems, not
accepted advisory risk. Normal tag and dry-run releases keep the advisory gate
enabled.

The audit gate depends on npm registry and advisory API availability. The retry
helper retries transient failures, and infrastructure failures are reported as
`npm audit infrastructure error` so they are distinguishable from dependency
advisories. The required dependency audit check intentionally fails closed when
npm advisory services are unavailable or when an accepted advisory expires, so
the repository can experience a merge freeze at the UTC date boundary. Signature
verification is also fail-closed in release and unprivileged build workflows; if
npm signature services are unavailable, the security CODEOWNERS own the outage
decision and either wait for service recovery or document an administrator
branch-protection/release emergency before bypassing it. The gate warns during
the final seven days before `reviewBy`; maintainers should use that warning to
renew or remove the entry before unrelated PRs and releases are blocked. On-call
maintainers unblock normal merges by removing/upgrading the affected dependency,
refreshing the accepted advisory through the protected policy process, waiting
for npm service recovery, or using administrator branch-protection break-glass
only when the operational emergency is documented. The scheduled weekly audit is
an early signal only; maintainers must still monitor failed scheduled runs in
GitHub Actions and renew or remove accepted advisories before their `reviewBy`
date.

## Unfinished Large File Cleanup

The extension cancels unfinished B2 large files only for upload sessions that
fail while the extension host is still running. If VS Code exits, crashes, the
extension host is killed, or the machine loses power during a multipart upload,
that in-process cleanup does not run. Operators should configure a B2 bucket
lifecycle rule that cancels abandoned unfinished large files so uploaded parts
do not remain billable indefinitely.

The guard scripts and CODEOWNERS rules protect against accidental or
trusted-contributor drift in the policy and workflows. They are not a substitute
for repository settings that require maintainer approval before running
workflows from untrusted forks.

If a future dependency legitimately requires a postinstall build step, do not
replace `npm ci --ignore-scripts` with plain `npm ci`. Add a targeted,
reviewable command such as `npm rebuild <package>` after the advisory audit,
document why that package needs scripts, and extend the guardrail tests.

## Accepted Dependency Advisories

The `acceptedAdvisories` list in `audit-policy.jsonc` stays empty unless a
tracked, time-boxed exception is required.
