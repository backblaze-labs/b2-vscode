# Conventions

Commit, code, and CI conventions for **b2-vscode**. The gate that enforces the
mechanical parts is one command: `npm run check` (see
[`development.md`](../development.md)).

## Commits

- **Conventional Commits**, single-line subject, imperative mood, ≤ 72 chars:
  `type: summary` — `feat` `fix` `docs` `test` `refactor` `chore` `perf`
  `build` `ci` `style`.
- No AI attribution or co-author trailers.
- Keep PRs short-lived and focused; corrections are cheap, waiting is expensive.

## Code style (enforced)

- **Prettier** (`package.json` `prettier` block): double quotes,
  `trailingComma: all`, `printWidth: 100`. Run `npm run format`.
- **ESLint** over `src` and `scripts/*.js`; **`tsc --noEmit`** must pass.
- Parse external/untrusted shapes **at the boundary** before use; never probe
  data "YOLO-style" (see [core-beliefs](core-beliefs.md)).
- Respect the layering in [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md):
  imports point down, never up.

## Contributed surface

The command/tool surface in `package.json` `contributes` is pinned by
`scripts/print-contributes-hash.js` + `release-contract.js`. Changing commands,
menus, or LM tools is deliberate — update the contract when you change the
surface.

## CI invariants

<a id="ci-invariants"></a>

**Dependabot PRs must report required checks.** Workflows that provide required
PR checks must run for every `pull_request` or trusted `pull_request_target`
event, including Dependabot-authored events. Do not add a Dependabot actor guard
to the VS Code Extension Tests job or the trusted dependency-audit gate; skipped
required jobs can leave dependency PRs without the checks needed to merge.

The trusted audit workflow (`test.yml`) must keep PR code isolated: it checks out
the protected base as `trusted-source`, downloads only PR dependency metadata,
and audits that metadata through trusted scripts. Untrusted PR code runs only in
unprivileged `pull_request` workflows.

Only non-required helper jobs that should avoid bot-authored events may carry a
Dependabot actor guard. For example, `post-pr-comment` in `build-extension.yml`
is guarded because it writes a PR comment and is not a required build or test
check.
