# Design docs — catalog

Catalogued design docs with a verification status, so stale guidance is visible.

**Status legend:** `current` — matches the code today · `stale` — needs review ·
`superseded` — replaced, kept for history.

| Doc                                                        | Scope                                    | Status  | Last verified |
| ---------------------------------------------------------- | ---------------------------------------- | ------- | ------------- |
| [core-beliefs.md](core-beliefs.md)                         | Agent-first operating principles         | current | 2026-08-27    |
| [conventions.md](conventions.md)                           | Commit / code / CI conventions           | current | 2026-08-27    |
| [../transfer-architecture.md](../transfer-architecture.md) | `fileTransfers` facade & transfer safety | current | 2026-08-27    |
| [../../ARCHITECTURE.md](../../ARCHITECTURE.md)             | Domains, layers, allowed edges           | current | 2026-08-27    |

## Conventions for this catalog

- One row per design doc. New design docs (dated, e.g. `2026-09-transfers.md`)
  are added here on creation.
- "Last verified" is the date a human or agent confirmed the doc matches the
  code. A drift/doc-gardening pass updates it or flips the status.
- Superseded docs stay in the tree with a link to their replacement.
