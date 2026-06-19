# Security Policy

## Dependency Audit Policy

The required `VS Code Extension Tests` check runs `audit-ci` against
`audit-ci.jsonc`, which audits the full npm dependency tree, including
development and release tooling, before package lifecycle scripts can run. The
gate fails on low, moderate, high, or critical advisories because tooling
dependencies participate in building, packaging, and testing the VSIX.

Runtime-only audits are still useful for triage, but they are not the blocking
policy for this repository. Available fixes should be applied by upgrading direct
dependencies, refreshing the lockfile, or replacing vulnerable tooling. CI also
verifies npm registry signatures and attestations with `npm audit signatures`.

The machine-readable allowlist in `audit-ci.jsonc` is the only accepted advisory
contract for CI. If an advisory cannot be fixed immediately, add the narrowest
allowlist entry possible before merging. Each entry must include `active: true`,
an `expiry` review date, and `notes` with the risk acceptance, owner, and issue
or pull request that tracks the fix.

For emergency or unrelated changes blocked by a new advisory, prefer a short
lived allowlist entry over bypassing branch protection. If an administrative
break-glass merge is unavoidable, open the allowlist or dependency fix pull
request before merging the emergency change and set the review date no later
than 30 days out.

## Accepted Dependency Advisories

There are no accepted unfixed npm advisories as of 2026-06-18. The allowlist in
`audit-ci.jsonc` is intentionally empty.
