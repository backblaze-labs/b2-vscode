# Tech-debt tracker

Logged deferred work, so it surfaces instead of rotting. Pay it down
continuously in small increments. Close an entry by linking the PR that resolves
it and striking the row.

**Severity:** `high` (correctness/security risk) · `med` (coherence/drift) ·
`low` (polish).

| ID                    | Severity | Item                                                                                                                                                                 | Added      | Notes                                                                                         |
| --------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------- |
| <a id="td-1"></a>TD-1 | med      | `src/utils/localPaths.ts` imports `src/services/pathSafety.ts` — an upward edge that violates the Utils-is-pure layer in [`ARCHITECTURE.md`](../../ARCHITECTURE.md). | 2026-08-27 | Fix by relocating the shared primitives, or moving `localPaths.ts` into `services/`.          |
| <a id="td-2"></a>TD-2 | med      | No mechanical **layer/dependency linter** enforces the layering table in `ARCHITECTURE.md`; it is grep-verifiable but not gated.                                     | 2026-08-27 | Promote to a `scripts/assert-layers.js` check whose failure message names the offending edge. |
| <a id="td-3"></a>TD-3 | low      | No `docs/` drift/staleness gate; `design-docs/index.md` "Last verified" dates are updated by hand.                                                                   | 2026-08-27 | Add a scheduled doc-gardening scan (see [core-beliefs](../design-docs/core-beliefs.md)).      |
