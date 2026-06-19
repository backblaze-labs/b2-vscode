# Security Policy

## Dependency Audit Policy

CI runs `npm run audit:ci`, which audits the full npm dependency tree, including
development and release tooling. The gate fails on moderate, high, or critical
advisories because tooling dependencies participate in building, packaging, and
testing the VSIX.

Runtime-only audits are still useful for triage, but they are not the blocking
policy for this repository. Available fixes should be applied by upgrading direct
dependencies, refreshing the lockfile, or replacing vulnerable tooling.

## Accepted Dependency Advisories

There are no accepted unfixed npm advisories as of 2026-06-18.

If an advisory cannot be fixed immediately, record it here before merging the
change that keeps it in the tree. Include the package, advisory URL, affected
scope, reason for accepting the risk, owner, and a review-by date.
