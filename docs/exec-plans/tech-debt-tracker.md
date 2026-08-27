# Tech-debt tracker

Logged deferred work, so it surfaces instead of rotting. Pay it down
continuously in small increments. Close an entry by resolving it and moving it
to the Resolved section.

**Severity:** `high` (correctness/security risk) · `med` (coherence/drift) ·
`low` (polish).

## Open

| ID                    | Severity | Item                                                                                               | Added      | Notes                                                                                                                                                                    |
| --------------------- | -------- | -------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| <a id="td-3"></a>TD-3 | low      | No `docs/` drift/staleness gate; `design-docs/index.md` "Last verified" dates are updated by hand. | 2026-08-27 | Add a `scripts/assert-docs.js` cross-link + freshness check to `npm run check`, and a scheduled doc-gardening scan (see [core-beliefs](../design-docs/core-beliefs.md)). |

## Resolved

| ID   | Item                                                                           | Resolution                                                                             |
| ---- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| TD-1 | `src/utils/localPaths.ts` imported `src/services/pathSafety.ts` (upward edge). | Moved to `src/services/localPaths.ts`; importers rewired.                              |
| TD-2 | No mechanical layer/dependency linter.                                         | Added `scripts/assert-layers.js` (`npm run check:layers`), wired into `npm run check`. |
