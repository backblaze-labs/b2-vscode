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

### Fixed

- Packaged CLI credential auto-detection now bundles the SQL.js runtime module
  and loads the WASM asset from the extension runtime directory
  (`dist/sql-wasm.wasm`). VSIX packaging now verifies the runtime bundle and
  WASM asset before release.

### Security

- Copilot (Language Model) tools now show explicit, effect-naming confirmations
  classified by risk. The irreversible `deleteFile` and the shareable-link
  `presignUrl` tools warn that the action cannot be undone or exposes data, so an
  agent cannot run them without a clear prompt. Documented the prompt-injection
  caution for agent mode in the README.

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
