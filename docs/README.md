# docs/ — system of record

The versioned knowledge base for **b2-vscode**. Code that disagrees with these
docs is a bug in one of them. Start from the map in [`../AGENTS.md`](../AGENTS.md);
this page routes into the tree.

## Layout

| Path                                                                 | What's there                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------ |
| [`../ARCHITECTURE.md`](../ARCHITECTURE.md)                           | domains, layers, allowed dependency edges              |
| [`development.md`](development.md)                                   | build, test, debug, git hooks                          |
| [`release.md`](release.md)                                           | release & Marketplace publishing                       |
| [`transfer-architecture.md`](transfer-architecture.md)               | the `fileTransfers` facade design                      |
| [`design-docs/`](design-docs/index.md)                               | catalogued design docs + verification status           |
| [`design-docs/core-beliefs.md`](design-docs/core-beliefs.md)         | agent-first operating principles                       |
| [`design-docs/conventions.md`](design-docs/conventions.md)           | commit / code / CI conventions                         |
| [`exec-plans/`](exec-plans/)                                         | in-flight (`active/`) and shipped (`completed/`) plans |
| [`exec-plans/tech-debt-tracker.md`](exec-plans/tech-debt-tracker.md) | logged deferred work                                   |
| [`product-specs/`](product-specs/index.md)                           | what the product is and who it serves                  |
| [`generated/`](generated/README.md)                                  | machine-generated references                           |
| [`references/`](references/README.md)                                | stack notes and external references                    |
| [`QUALITY_SCORE.md`](QUALITY_SCORE.md)                               | per-domain/layer grades and gaps                       |

Root-level docs that stay at the repo root by convention:
[`../README.md`](../README.md) (users), [`../SECURITY.md`](../SECURITY.md)
(policy + threat model), [`../LICENSE.txt`](../LICENSE.txt),
[`../CHANGELOG.md`](../CHANGELOG.md).

Generated API reference (typedoc) is written to `api-docs/` (git-ignored) via
`npm run api-docs`; it is not part of this system of record.

## Keeping it healthy

- Write concise docs — say it once, link instead of repeating.
- When a doc rule needs teeth, promote it into a `scripts/assert-*.js` check.
- Log deferrals in the [tech-debt tracker](exec-plans/tech-debt-tracker.md)
  instead of letting them rot.
