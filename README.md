# Backblaze B2 for VS Code

Browse, manage, and interact with your Backblaze B2 Cloud Storage directly from VS Code.

## Features

- **Bucket Explorer** — tree view in the activity bar showing all your B2 buckets, folders, and files
- **Auto-authentication** — automatically detects B2 CLI credentials (`~/.b2_account_info`), environment variables, or VS Code SecretStorage
- **Bucket management** — create, delete, and change bucket visibility (public/private)
- **File operations** — open, download, rename, and delete files; create folders
- **Copilot tools** — language model tools for B2 operations (list buckets, get file info, download, upload, delete, presign URLs)
- **SARIF-compatible output** — structured logging for CI/CD integration
- **Powered by the official SDK**: all B2 access goes through [`@backblaze-labs/b2-sdk`](https://www.npmjs.com/package/@backblaze-labs/b2-sdk) (product User-Agent, auth refresh, retry with backoff, SSRF guard)

## Getting Started

### Authentication

The extension resolves credentials in this order:

1. **VS Code SecretStorage** — persisted and encrypted (set via the Authenticate command)
2. **Environment variables** — `B2_APPLICATION_KEY_ID` and `B2_APPLICATION_KEY`
3. **B2 CLI database** — `~/.b2_account_info` (created by the `b2` CLI tool)

If you have the B2 CLI installed and have run `b2 account authorize`, the extension will automatically authenticate on startup.

### Manual Authentication

1. Open the Backblaze B2 sidebar (flame icon in the activity bar)
2. Click the key icon or run **B2: Authenticate** from the command palette
3. Enter your Application Key ID and Application Key

### Custom API URL

The `b2.apiUrl` setting defaults to `https://api.backblazeb2.com`. Custom B2-compatible endpoints are supported only from VS Code user settings, not workspace settings, so a cloned repository cannot redirect your credentials through `.vscode/settings.json`.

Custom values must be HTTPS URLs without embedded credentials, query strings, or fragments. The threat model is credential redirection: a malicious workspace should not be able to point the extension at an attacker-controlled endpoint and receive your B2 application key. When the value is not the default Backblaze endpoint, the extension shows a confirmation warning before sending any B2 application key material to that endpoint.

### Public Bucket Visibility

Creating a public bucket or changing a private bucket to public requires a modal confirmation and typed bucket-name confirmation. Public B2 buckets can make current and future files accessible without authorization, so use public visibility only when object-level public access is intentional.

If a public bucket create or visibility-change request fails in a way that leaves the final B2 state uncertain, the extension refreshes the bucket tree and shows a modal warning that the bucket may already be public.

## Commands

| Command                        | Description                               |
| ------------------------------ | ----------------------------------------- |
| `B2: Authenticate`             | Sign in with B2 credentials               |
| `B2: Logout`                   | Clear stored credentials                  |
| `B2: Refresh`                  | Reload the bucket tree                    |
| `B2: Create Bucket`            | Create a new B2 bucket                    |
| `B2: Change Bucket Visibility` | Toggle public/private                     |
| `B2: New Folder`               | Create a folder in a bucket               |
| `B2: Rename File`              | Rename a file (server-side copy + delete) |
| `B2: Delete Bucket`            | Delete an empty bucket                    |
| `B2: Delete Folder`            | Delete a folder and all its contents      |
| `B2: Delete File`              | Delete a file                             |

## Copilot Integration

When GitHub Copilot is available, the extension registers language model tools:

- `listBuckets` — list all accessible buckets
- `listFiles` — list files in a bucket/folder
- `getFileInfo` — get metadata for a specific file
- `downloadFile` — download a file to the first open workspace folder by default, or to a workspace-relative `localPath` whose filename segments are sanitized once for portable writes; existing files are not overwritten
- `uploadFile` — upload a workspace-relative local file from the first open workspace folder to a bucket
- `deleteFile` — delete a file by name
- `presignUrl` — generate a time-limited prefix download URL after a direct B2 list-file-names verification confirms the prefix currently names one file and no current same-prefix sibling files

### Tool safety

Several tools change state or expose data: `uploadFile` reads a workspace-relative file from the first open workspace folder and sends it to B2, `downloadFile` writes a workspace-relative file into the first open workspace folder, `deleteFile` permanently deletes a file, and `presignUrl` mints a shareable prefix download link after a direct B2 list call validates that the prefix currently names one B2 file and no current same-prefix sibling files. Before any of these runs, the extension shows a confirmation that names the exact effect (for example, "permanently delete b2://bucket/key"), and destructive or data-exposing tools are flagged as irreversible or exfiltration-capable.

In agent mode, treat bucket listings and file contents as untrusted input: an agent that reads them can be steered by injected instructions toward a destructive or data-sharing call. Review each confirmation, avoid blanket auto-approval for these tools, and use B2 application keys scoped to the least privilege the task needs.

Downloads are capped at 1 GiB by default for open-file temp cache reads and at 512 MiB for `downloadFile` workspace writes. If a remote stream exceeds the cap or stalls, the transfer aborts and the partial local file is removed.

Large uploads tag in-progress multipart sessions so the extension can cancel its own failed upload session without touching uploads from another VS Code window or machine. On activation, stale unfinished-upload cleanup is limited to uploads that still have locally persisted session markers for this extension, so unowned B2 uploads are not touched. Unfinished uploads created by older extension versions, crashes, power loss, or failed cleanup may remain in B2, so bucket operators should configure a B2 lifecycle rule or use B2 tools to remove legacy unfinished multipart uploads before they accumulate storage cost.

## Development

Use Node.js 22.13.0 or newer. CI runs the declared lower bound so the
development contract stays aligned with the toolchain dependency graph.

```bash
# Install dependencies
npm install

# Compile (includes icon font build)
npm run compile

# Watch mode
npm run watch

# Run all quality checks
npm run check

# Install Husky Git hooks
npm run install:hooks

# Run Node unit/property tests and VS Code extension tests
npm test

# Audit the full dependency tree using audit-policy.jsonc
npm run audit:ci

# Fix formatting and lint issues
npm run check:fix

# Generate API documentation
npm run docs

# Package VSIX
npm run vsix

# Install VSIX locally
npm run vsix:install
```

Release and Marketplace publishing ownership, preflight, secret scope, artifact
provenance, and rollback are documented in
[`docs/release.md`](docs/release.md).
Local Git hook setup is documented in [`docs/development.md`](docs/development.md).

Expected test output includes the discovery guard and a nonzero Mocha summary, for example
`Discovered N compiled test file(s) for M source test file(s).` followed by a nonzero
`passing` count. If the compiled test files are missing, `npm test` exits nonzero instead of
reporting `0 passing`; Mocha is also configured to fail zero-test and pending-test runs.

See [SECURITY.md](SECURITY.md) for the dependency audit policy and accepted
advisory process.

## Architecture

```
src/
├── extension.ts              # Activation, auto-auth, lifecycle
├── constants.ts              # API endpoints, keys, view IDs
├── types.ts                  # B2 API response types
├── logger.ts                 # Output channel logging
├── commands/index.ts         # Command registrations
├── services/
│   ├── authService.ts        # Credential resolution (4-tier)
│   ├── b2.ts                 # B2 SDK client factory
│   ├── fileTransfers.ts      # Upload/download transfer facade
│   ├── pathSafety.ts         # Workspace and filesystem path containment
│   ├── tempFileManager.ts    # Downloaded file cache
│   ├── transferTempFiles.ts  # Transfer temp files and atomic destination moves
│   ├── transferTimeout.ts    # Transfer stall timeout orchestration
│   └── transferProgress.ts   # VS Code transfer progress/cancellation
├── providers/
│   └── b2TreeProvider.ts     # Tree data provider
├── models/
│   ├── bucketTreeItem.ts     # Bucket tree node
│   ├── folderTreeItem.ts     # Folder tree node
│   └── fileTreeItem.ts       # File tree node
├── tools/                    # Copilot language model tools
│   ├── registration.ts
│   ├── b2ToolAdapter.ts
│   ├── definitions/          # Tool schemas
│   └── operations/           # Tool implementations
├── ui/
│   └── statusBar.ts          # Status bar integration
└── utils/
    └── humanSize.ts          # Human-readable byte formatting
```

Transfer orchestration is consolidated in `fileTransfers.ts` so timeout handling, temp-file
staging, atomic publish, unfinished-upload cleanup, and upload/download stream behavior share one
service boundary.

## License

MIT
