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

Custom values must be HTTPS URLs without embedded credentials, query strings, or fragments. When the value is not the default Backblaze endpoint, the extension shows a confirmation warning before sending any B2 application key material to that endpoint.

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
- `downloadFile` — download a file to a local temp directory
- `uploadFile` — upload a file to a bucket
- `deleteFile` — delete a file by name
- `presignUrl` — generate a time-limited download URL

## Development

```bash
# Install dependencies
npm install

# Compile (includes icon font build)
npm run compile

# Watch mode
npm run watch

# Run all quality checks
npm run check

# Fix formatting and lint issues
npm run check:fix

# Generate API documentation
npm run docs

# Package VSIX
npm run vsix

# Install VSIX locally
npm run vsix:install
```

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
│   ├── b2.ts                 # B2 SDK client factory + stream helper
│   └── tempFileManager.ts    # Downloaded file cache
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
└── ui/
    └── statusBar.ts          # Status bar integration
```

## License

MIT
