# Release and Marketplace Publishing

This project publishes the Backblaze B2 VS Code extension from the `Release`
GitHub Actions workflow.

## Ownership

- Release approval and Marketplace publishing are owned by Backblaze Labs
  maintainers with write access to `backblaze-labs/b2-vscode`.
- Stable Marketplace publishes should be reviewed by a maintainer who can also
  confirm the GitHub Release notes and VSIX artifact checksums.
- The `marketplace` GitHub environment is the intended place for any required
  reviewer protection on the final publish job.

## Secrets

- `VSCE_KEY` is the only Marketplace publishing secret used by the workflow.
- Scope `VSCE_KEY` to the repository or to the `marketplace` environment, not to
  unrelated repositories.
- The token must have publish rights for the `backblaze` VS Code Marketplace
  publisher. The release workflow verifies the token with `vsce verify-pat`
  before publishing.
- Do not expose `VSCE_KEY` to pull request workflows from forks or to local
  scripts.

## Preflight and Release Flow

Run the `Release` workflow manually with `publish=false` for a dry-run/preflight.
That path runs the same quality, behavioral test, dependency audit, CodeQL SAST,
VSIX validation, installed-VSIX smoke, and provenance attestation jobs without
publishing to the Marketplace.

For a stable release:

1. Land the reviewed release commit on `main`.
2. Ensure `package.json` has the intended version.
3. Create and push a `vX.Y.Z` tag that matches `package.json`.
4. Let the `Release` workflow run all gates.
5. Confirm the GitHub Release includes the VSIX and `VSIX_SHA256SUMS.txt`.
6. Confirm the attestation is present for the VSIX artifact.
7. Confirm the Marketplace listing shows the new version after the publish job.

Prerelease tags containing `-` create prerelease GitHub Releases and skip the
stable Marketplace publish path.

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
