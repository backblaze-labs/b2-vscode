# Architecture

Top-level map of **b2-vscode**. This is the structural contract; keep it current
when modules move. Deeper design rationale lives in
[`docs/design-docs/index.md`](docs/design-docs/index.md).

b2-vscode is a single VS Code extension (one product domain: _Backblaze B2 access
inside VS Code_). It surfaces B2 through a tree view, palette commands, and
Copilot language-model tools, all routed through the official
[`@backblaze-labs/b2-sdk`](https://www.npmjs.com/package/@backblaze-labs/b2-sdk).

## Layers

Dependencies point **down** the table. A module may import from its own layer and
any layer below it, **never up**.

| #   | Layer            | Path                                                                            | May depend on              | Role                                                        |
| --- | ---------------- | ------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------- |
| 4   | Composition root | `src/extension.ts`                                                              | all below                  | `activate()`; constructs services and registers integration |
| 3   | Integration      | `src/commands/`, `src/tools/`, `src/providers/`, `src/models/`, `src/ui/`       | Services, Utils            | VS Code commands, tree, status bar, and Copilot LM tools    |
| 2   | Services         | `src/services/`                                                                 | Utils, SDK, node, `vscode` | auth, B2 client, transfers, path safety, temp files         |
| 1   | Utils / Types    | `src/utils/`, `src/constants.ts`, `src/types.ts`, `src/errors.ts`               | (pure)                     | dependency-free helpers and shared types                    |
| —   | Cross-cutting    | `src/logger.ts`, `src/toolPathSafety.ts`                                        | Utils                      | structured logging; shared path-safety entry used by tools  |
| —   | Harness          | `scripts/`, `.github/workflows/`, `test-harness.config.mjs`, `.vscode-test.mjs` | —                          | gates, release, audit, VSIX, and test tooling               |

**Enforced invariants** (`scripts/assert-layers.js`, run by `npm run check`):
`src/utils/**` imports nothing above Utils; `src/services/**` imports nothing
from the Integration layer. Only `extension.ts` spans all layers.

## Integration layer detail

- `commands/` — palette + context-menu commands (`index.ts`, `renameFile.ts`,
  `publicBucketVisibility.ts`).
- `providers/b2TreeProvider.ts` + `models/*TreeItem.ts` — the Buckets tree
  (`bucket → folder → file`, plus `loadMore` / `listingLimit` rows).
- `tools/` — Copilot language-model tools, split into `definitions/` (schemas +
  confirmation text) and `operations/` (execution), wired by `registration.ts`
  through `b2ToolAdapter.ts`. Paths flow through `b2ObjectName.ts` /
  `localPaths.ts` / `toolPathSafety.ts` before any I/O.
- `ui/statusBar.ts` — auth-state indicator.

## Services layer detail

`b2.ts` (SDK client + credential resolution), `authService.ts` (auth state +
`b2.authenticated` context key), `fileTransfers.ts` (the download/upload/cleanup
facade — see [`docs/transfer-architecture.md`](docs/transfer-architecture.md)),
`pathSafety.ts` + `pathErrorSanitization.ts` (contained-path + real-directory
enforcement), `tempFileManager.ts` / `transferTempFiles.ts` /
`transferTimeout.ts` / `transferProgress.ts` (transfer machinery),
`errorCode.ts`, `localPaths.ts` (B2 object name → contained local path),
`sqlJsLoader.ts` (reads the B2 CLI SQLite credential DB).

## Enforcement (invariants, not implementations)

The gate is one command — `npm run check` — mirrored in CI
(`.github/workflows/`). It runs Prettier, ESLint, `tsc --noEmit`, and the
repo's own assertions in `scripts/`:

- `assert-package-metadata.js`, `assert-release-workflow.js`,
  `assert-audit-*.js`, `assert-vsix-*.js` — structural gates on metadata,
  release safety, the dependency-audit policy, and packaged VSIX contents.
- `print-contributes-hash.js` / `release-contract.js` — pin the contributed
  command/tool surface so `package.json` changes are deliberate.

When a doc rule needs teeth, promote it into a `scripts/assert-*.js` check whose
failure message tells the agent how to fix it. The layering table above is
enforced by `scripts/assert-layers.js` (`npm run check:layers`).

## UI/UX conventions

The extension is native-first (no webviews today). Interaction conventions for
new features live upstream in the issue tracker
([conventions](https://github.com/backblaze-labs/b2-vscode/issues/87),
[information architecture](https://github.com/backblaze-labs/b2-vscode/issues/104)).
