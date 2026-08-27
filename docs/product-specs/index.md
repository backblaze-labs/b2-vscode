# Product specs

What **b2-vscode** is for and who it serves. The user-facing feature list lives
in [`../../README.md`](../../README.md); this is the intent behind it.

## What it is

A VS Code extension that brings Backblaze B2 Cloud Storage into the editor:
browse buckets/folders/files in a tree, run bucket and file operations, and
expose B2 to Copilot as language-model tools. All access goes through the
official [`@backblaze-labs/b2-sdk`](https://www.npmjs.com/package/@backblaze-labs/b2-sdk).

## Who it serves

Developers and DevOps/platform engineers who already work in VS Code and want to
inspect and manage B2 without switching to the web console or CLI — including
agent-driven workflows via the Copilot tools.

## Principles

- **Native-first UX.** Prefer built-in VS Code primitives; a webview must earn
  its place. See the interaction conventions
  ([#87](https://github.com/backblaze-labs/b2-vscode/issues/87)) and information
  architecture ([#104](https://github.com/backblaze-labs/b2-vscode/issues/104)).
- **Safe by default.** Destructive and data-exposing actions (public buckets,
  deletes, presigned links, custom endpoints) require explicit confirmation; see
  [`../../SECURITY.md`](../../SECURITY.md).
- **Least surprise.** Credentials resolve predictably (SecretStorage → env →
  B2 CLI DB); custom API endpoints are opt-in and confirmed.

## Roadmap

Feature work is tracked as GitHub issues under the `sdk-parity` label and the
[tracking issue #74](https://github.com/backblaze-labs/b2-vscode/issues/74).
Larger efforts get an [execution plan](../exec-plans/active/).
