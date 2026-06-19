# Release and Marketplace Publishing

This project publishes the Backblaze B2 VS Code extension from the `Release`
GitHub Actions workflow.

## Ownership

- Release approval and Marketplace publishing are owned by Backblaze Labs
  maintainers with write access to `backblaze-labs/b2-vscode`.
- Stable Marketplace publishes should be reviewed by a maintainer who can also
  confirm the GitHub Release notes and VSIX artifact checksums.
- The `marketplace` GitHub environment must have required reviewer protection on
  the final publish job. The release workflow blocks the publish job unless that
  environment has required reviewers configured.

## Secrets

- `VSCE_KEY` is the only Marketplace publishing secret used by the workflow.
- Scope `VSCE_KEY` to the protected `marketplace` environment. Do not also keep
  a repo-level copy unless there is a documented break-glass reason.
- The token must have publish rights for the `backblaze` VS Code Marketplace
  publisher. The release workflow verifies the token from the same
  `marketplace` environment context that performs publishing.
- Do not expose `VSCE_KEY` to pull request workflows from forks or to local
  scripts.

## Preflight and Release Flow

Run the `Release` workflow manually with `publish=false` for a dry-run/preflight.
That path runs quality, behavioral test, dependency audit, CodeQL SAST, strict
VSIX validation, and installed-VSIX smoke without reading `VSCE_KEY`. Provenance
attestation and Marketplace publishing only run for `v*.*.*` tag refs.

The dependency audit gate is scoped to runtime dependencies with
`npm audit --omit=dev --audit-level=moderate`, so a release is not blocked by a
new advisory in build-only tooling. Dev dependency advisories should still be
reviewed before release when they affect workflow code execution or packaging.

When changing Marketplace contributions in `package.json`, review the new
commands, views, menus, language model tools, and activation surface, then run
`npm run contract:hash` and update `manifestContract.contributesSha256` in the
same PR.

For a stable release:

1. Land the reviewed release commit on `main`.
2. Ensure `package.json` has the intended version.
3. Create and push a protected `vX.Y.Z` tag that matches `package.json`.
4. Let the `Release` workflow verify that the tag commit is reachable from
   `origin/main`, run all gates, attest the exact checksummed VSIX, and publish
   to the Marketplace from the protected `marketplace` environment.
5. Confirm the GitHub Release includes the VSIX and `VSIX_SHA256SUMS.txt`.
6. Confirm the attestation is present for the VSIX artifact.
7. Confirm the Marketplace listing shows the new version after the publish job.

Prerelease tags containing `-` create prerelease GitHub Releases and skip the
stable Marketplace publish path. Stable GitHub Releases are created only after
the Marketplace publish job succeeds, so a publish failure does not advertise an
unpublished stable version.

## Rollback

Marketplace versions are immutable. To roll back a bad stable release, publish a
new patch version that reverts or disables the bad change, then mark the affected
GitHub Release as superseded in its notes. Use `vsce unpublish` only for severe
cases where removal is preferable to replacement, and require explicit maintainer
approval before doing so.

After rollback:

- Link the rollback PR to the incident or release issue.
- Confirm the replacement VSIX passes the release gates.
- Confirm the Marketplace listing and GitHub Release point users to the fixed
  version.
