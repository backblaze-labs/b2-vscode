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

**Dependabot PRs must never run CI.** Every job in every workflow under
`.github/workflows/` that reacts to `pull_request` or `pull_request_target` is
guarded with:

```yaml
if: ${{ github.actor != 'dependabot[bot]' }}
```

so a Dependabot-authored event skips all jobs and no CI runs. `release.yml` is
tag / `workflow_dispatch` only and is not Dependabot-reachable, so it carries no
guard.

When adding a new workflow or job, add the same guard to preserve this
invariant. For a job that already has an `if:`, AND the guard into the existing
condition (see `post-pr-comment` in `build-extension.yml`).

This intentionally also skips the trusted dependency-audit gate (`test.yml`,
`pull_request_target`) for Dependabot PRs. Vet Dependabot dependency bumps
manually, or temporarily re-enable that one job, before merging them.
