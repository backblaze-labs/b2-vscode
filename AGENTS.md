# AGENTS.md

Map for AI assistants and humans working on **b2-vscode** — the Backblaze B2
extension for VS Code. This file is a table of contents, not a manual: it points
to the system of record in [`docs/`](docs/README.md). Keep it short (~100 lines);
put detail in the doc it belongs to and link here.

**Canonical guide.** This is the single source of truth for agents. Tool-specific
files ([`CLAUDE.md`](CLAUDE.md)) point here rather than duplicating it.

## How we work here

- **Humans steer; agents execute.** When something fails, the fix is not "try
  harder" — ask _what capability, doc, or guardrail is missing_ and add it.
- **The repo is the system of record.** If it isn't in the repo, it doesn't
  exist. Push context in; prefer versioned artifacts over chat and memory.
- **Enforce invariants mechanically, not by convention.** See
  [`ARCHITECTURE.md`](ARCHITECTURE.md) and `scripts/assert-*.js`.
- **Write concise docs.** Say it once, link instead of repeating. Read the
  operating principles in [`docs/design-docs/core-beliefs.md`](docs/design-docs/core-beliefs.md).

## The one gate

Run the full local gate before proposing a change — it mirrors CI:

```bash
npm run check   # prettier + eslint + tsc --noEmit + package-metadata + release-workflow
```

Tests: `npm test` (VS Code integration) and `npm run test:unit`. Hooks install via
`npm install` (Husky pre-commit runs `npm run check`). More in
[`docs/development.md`](docs/development.md).

## Architecture

[`ARCHITECTURE.md`](ARCHITECTURE.md) is the top-level map: domains, the
`utils → services → integration → extension` layering, and allowed dependency
edges. Design docs are catalogued in
[`docs/design-docs/index.md`](docs/design-docs/index.md).

Layer summary (dependencies point **down**; never up):

| Layer            | Path                                            | Role                                        |
| ---------------- | ----------------------------------------------- | ------------------------------------------- |
| Composition root | `src/extension.ts`                              | activation; wires everything                |
| Integration      | `src/{commands,tools,providers,models,ui}/`     | VS Code + Copilot LM tools                  |
| Services         | `src/services/`                                 | auth, B2 SDK client, transfers, path safety |
| Utils / Types    | `src/utils/`, `src/{constants,types,errors}.ts` | pure, dependency-free                       |
| Harness          | `scripts/`, `.github/workflows/`                | gates, release, audit tooling               |

## Where things live

| Need                                | Go to                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| How to build/test/debug             | [`docs/development.md`](docs/development.md)                                   |
| Architecture & layering             | [`ARCHITECTURE.md`](ARCHITECTURE.md)                                           |
| Operating principles (agent-first)  | [`docs/design-docs/core-beliefs.md`](docs/design-docs/core-beliefs.md)         |
| Commit / code / CI conventions      | [`docs/design-docs/conventions.md`](docs/design-docs/conventions.md)           |
| Design docs catalog (+ status)      | [`docs/design-docs/index.md`](docs/design-docs/index.md)                       |
| What the product is / who it serves | [`docs/product-specs/index.md`](docs/product-specs/index.md)                   |
| In-flight & shipped plans           | [`docs/exec-plans/`](docs/exec-plans/)                                         |
| Known deferred work                 | [`docs/exec-plans/tech-debt-tracker.md`](docs/exec-plans/tech-debt-tracker.md) |
| Per-domain quality grades           | [`docs/QUALITY_SCORE.md`](docs/QUALITY_SCORE.md)                               |
| Release & Marketplace               | [`docs/release.md`](docs/release.md)                                           |
| Security policy & threat model      | [`SECURITY.md`](SECURITY.md)                                                   |
| Generated references                | [`docs/generated/`](docs/generated/)                                           |
| Stack notes & external refs         | [`docs/references/`](docs/references/)                                         |
| User-facing overview                | [`README.md`](README.md)                                                       |

## Golden rules

1. `AGENTS.md` is a map, not an encyclopedia — link to the source of truth.
2. `docs/` is the system of record; code that disagrees with it is a bug in one.
3. Progressive disclosure: small stable entry point → pointers to deeper docs.
4. If the agent can't see it in-repo, it doesn't exist.
5. Enforce invariants (layers, boundaries) mechanically; error messages give the fix.
6. Prefer boring, internalizable tech; keep in-repo helpers small and well-tested.
7. Plans are first-class artifacts; log tech debt instead of letting it rot.
8. When docs fall short, promote the rule into code (a lint / `assert-*` script).
9. Pay tech debt down continuously in small increments.
10. Write concise docs — too much guidance becomes non-guidance.

Full rationale: [`docs/references/harness-engineering.md`](docs/references/harness-engineering.md).
