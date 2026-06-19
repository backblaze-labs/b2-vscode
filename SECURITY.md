# Security Policy

## Dependency Audit Policy

The required `VS Code Extension Tests` check runs the lockfile-pinned `audit-ci`
binary against `audit-ci.jsonc`, which audits the full npm dependency tree,
including development and release tooling. The required test check and the
release workflow install dependencies with `npm ci --ignore-scripts`, so package
lifecycle scripts cannot run before the advisory gate evaluates the lockfile on
those paths. The gate fails on moderate, high, or critical advisories because
tooling dependencies participate in building, packaging, and testing the VSIX.

Runtime-only audits are still useful for triage, but they are not the blocking
policy for this repository. Available fixes should be applied by upgrading direct
dependencies, refreshing the lockfile, or replacing vulnerable tooling. CI also
verifies npm registry signatures and attestations with `npm audit signatures`.
Low-severity advisories are not merge-blocking; they are triaged through
Dependabot updates and can be checked locally with `npm audit --audit-level=low`.
If signature verification fails because a legitimate transitive package is
unsigned, treat it as a supply-chain exception: open a tracking issue with owner
and review date, then use the break-glass process only when the release or merge
cannot wait.

`audit-ci.jsonc` intentionally keeps an empty allowlist. The required
`Assert audit policy guardrails` step fails if the severity threshold is relaxed,
if allowlist entries are added, or if the local `audit:ci` script stops matching
the pinned local audit-ci invocation.

For emergency or unrelated changes blocked by a new moderate-or-higher advisory
without an available fix, an administrator may use branch-protection break-glass
after opening a tracking issue that records the package, advisory URL, affected
scope, risk acceptance, owner, and review-by date. The review date must be no
later than 30 days out, and the follow-up should remove, replace, or upgrade the
affected dependency as soon as possible.

If a future dependency legitimately requires a postinstall build step, do not
replace `npm ci --ignore-scripts` with plain `npm ci`. Add a targeted,
reviewable command such as `npm rebuild <package>` after the advisory audit,
document why that package needs scripts, and extend the guardrail tests.

## Accepted Dependency Advisories

There are no accepted unfixed npm advisories as of 2026-06-18. The allowlist in
`audit-ci.jsonc` is intentionally empty.
