# Changelog

## [Unreleased]

### Changed

- Replaced the hand-rolled native B2 HTTP client with the official
  [`@backblaze-labs/b2-sdk`](https://www.npmjs.com/package/@backblaze-labs/b2-sdk)
  package. Bucket and file operations now use the SDK's high-level `B2Client` /
  `Bucket` facade, which adds a product User-Agent, automatic auth refresh and
  retry with backoff, and an SSRF guard.
- Raised the minimum supported VS Code to 1.101, whose extension host runs
  Node 22, matching the SDK's runtime requirement.
- `presignUrl` now requires an integer expiration from 1 to 3600 seconds,
  defaults to 300 seconds, and rejects empty paths, folder-like paths, and paths
  that `listFiles` cannot
  verify as one existing downloadable B2 file with no current same-prefix
  sibling files before issuing a prefix-based download authorization. The
  token-bearing link is returned in the structured `url` field rather than
  repeated in the human-readable message.
- Removed automatic activation-time cancellation of stale unfinished large-file
  uploads. Interrupted multipart uploads are no longer reclaimed on startup;
  configure a B2 lifecycle rule or manually cancel unfinished uploads to bound
  storage for crashed or killed transfers.

### Fixed

- Marketplace package metadata now points to the canonical
  `backblaze-labs/b2-vscode` repository URL.
- File transfers now fail stalled uploads, downloads, and zero-byte folder-marker
  uploads with a bounded timeout instead of leaving progress notifications
  pending indefinitely.
- Packaged CLI credential auto-detection now loads copied SQL.js runtime assets
  from the extension runtime directory (`dist/sql-wasm.js` and
  `dist/sql-wasm.wasm`). VSIX packaging now verifies pinned SQL.js runtime and
  WASM SHA-256 values and statically checks that the bundle does not require
  repository `node_modules`. The publish preflight runs the same dist asset
  checks, SQL.js tarball provenance fetches retry transient failures and fall
  back to locally pinned assets when the registry is unavailable, and offline
  runners can set `B2_VSCODE_SKIP_SQLJS_PROVENANCE_FETCH=1` or pass
  `--skip-sqljs-provenance-fetch` to avoid the network fetch while retaining
  local SHA-256 verification.

### Security

- Copilot (Language Model) tools now show explicit, effect-naming confirmations
  classified by risk. The irreversible `deleteFile` and the shareable-link
  `presignUrl` tools warn that the action cannot be undone or exposes data, so an
  agent cannot run them without a clear prompt. Documented the prompt-injection
  caution for agent mode in the README.
- Creating public buckets and changing private buckets to public now require a
  modal warning plus exact bucket-name confirmation. Ambiguous failures after a
  public-affecting visibility request refresh the bucket tree and warn that the
  bucket may already be public.
- Automatic global cleanup of stale unfinished multipart uploads has been
  removed because B2 file info is caller-controlled. Failed uploads cancel
  unfinished uploads that match the active upload session only. Activation-time
  stale cleanup is limited to uploads with locally persisted session markers so
  another live VS Code window or machine is not touched. Operators should
  configure a B2 lifecycle rule or use B2 tools to clean legacy unfinished
  multipart uploads so older extension versions, crashes, or power-loss orphans
  cannot accumulate storage cost.
- Open-file cache downloads now enforce a 1 GiB default size cap, abort
  oversized streams, and remove partial local files.
- Interactive open-file downloads now stream with the same 5-minute stall
  timeout as other local transfer paths.
- `downloadFile` now confines workspace-relative `localPath` destinations to the
  first open workspace folder, rejecting absolute paths, traversal attempts, and
  symlink escapes before writing downloaded object data. Downloads enforce a
  512 MiB limit and stream into extension-owned temporary files before publishing
  the final path without overwriting an existing workspace file.
- `uploadFile` now confines workspace-relative `localPath` sources to the first
  open workspace folder, rejecting absolute paths, traversal attempts, and
  symlink escapes before reading and uploading local file content.
- Temporary download caching now rejects bucket or file names that normalize
  outside the cache root or traverse through symlinked cache parents.

## [0.0.1] — 2026-03-25

### Added

- Bucket explorer tree view with Backblaze flame icon in the activity bar
- Auto-authentication from B2 CLI stored credentials (`~/.b2_account_info`)
- 4-tier credential resolution: SecretStorage, env vars, B2 CLI database, manual input
- Bucket management: create, delete, change visibility (public/private)
- File operations: open, download, rename, delete
- Folder creation with `.bzEmpty` marker files
- Copilot language model tools: listBuckets, listFiles, getFileInfo, downloadFile, uploadFile, deleteFile, presignUrl
- Custom icon font built from Backblaze flame SVG
- B2 API v3 support with proper response parsing
- Human-friendly B2 API error messages
- Status bar integration showing authentication state
- SARIF-compatible structured logging
- GitHub Actions CI: code quality, build, docs, release workflows
- VSIX packaging support
