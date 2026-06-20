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
- Download and temp-open paths now preserve natural B2 object basenames while
  sanitizing traversal and platform-unsafe path segments before writing locally.
  Characters that are unsafe on Windows, such as `:`, `?`, and `*`, are encoded
  on every host so downloaded names remain portable.
- Copilot `downloadFile` / `uploadFile` local paths are workspace-relative;
  absolute local paths are no longer accepted, download destinations are
  sanitized before writing, and existing local files are not overwritten.
- Streaming downloads stage temporary files beside the final destination by
  default, avoiding RAM-backed system temp directories and cross-device recopy
  for large downloads.

### Fixed

- Marketplace package metadata now points to the canonical
  `backblaze-labs/b2-vscode` repository URL.
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
  unfinished uploads that match the active upload session only. The extension
  does not run age-based stale cleanup because another live VS Code window or
  machine could still be writing an old unfinished upload. Operators should
  configure a B2 lifecycle rule or use B2 tools to clean legacy unfinished
  multipart uploads so older extension versions, crashes, or power-loss orphans
  cannot accumulate storage cost.
- Workspace downloads and open-file cache downloads now enforce a 1 GiB default
  size cap, abort oversized streams, and remove partial local files.
- Interactive open-file downloads now stream with the same 5-minute stall
  timeout as other local transfer paths.
- Copilot download tools now reject absolute, symlinked, or directory
  destinations that would write outside the active workspace or create unsafe
  local filenames.
- LM `downloadFile` writes only to workspace-relative paths and refuses to
  overwrite existing workspace files. LM `uploadFile` reads only
  workspace-relative files.
- `presignUrl` now rejects empty, slash-terminated, or too-short paths,
  validates `expiresIn` between 1 and 3600 seconds, and explicitly reports that
  B2 download authorization tokens are name-prefix scoped. Presigned URLs
  default to 300 seconds; longer-lived links require an explicit `expiresIn`.
- Temp-open downloads now use a private per-process cache directory with
  owner-only file permissions. Stale temp-root cleanup preserves active roots
  with live owner markers or recently updated child files.
- Interrupted large uploads persist a local owner marker before multipart
  transfer starts, so matching stale unfinished uploads can be reclaimed after
  restart. Configure a B2 bucket lifecycle rule as a backstop for stale
  unfinished large files after deleted local state or host termination.

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
