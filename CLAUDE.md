# CLAUDE.md

Guidance for AI assistants working on `b2-vscode`.

## CI and Dependabot

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

Note: this intentionally also skips the trusted dependency-audit gate
(`test.yml`, `pull_request_target`) for Dependabot PRs. Vet Dependabot dependency
bumps manually, or temporarily re-enable that one job, before merging them.
