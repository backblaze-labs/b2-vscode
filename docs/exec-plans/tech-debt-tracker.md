# Tech-debt tracker

Logged deferred work, so it surfaces instead of rotting. Pay it down
continuously in small increments. Add new entries under Open; move them to
Resolved once fixed.

**Severity:** `high` (correctness/security risk) · `med` (coherence/drift) ·
`low` (polish).

## Open

_None currently._

## Resolved

| ID   | Item                                                                           | Resolution                                                                                                   |
| ---- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| TD-1 | `src/utils/localPaths.ts` imported `src/services/pathSafety.ts` (upward edge). | Moved to `src/services/localPaths.ts`; importers rewired.                                                    |
| TD-2 | No mechanical layer/dependency linter.                                         | Added `scripts/assert-layers.js` (`npm run check:layers`), wired into `npm run check`.                       |
| TD-3 | No `docs/` drift/staleness gate.                                               | Added `scripts/assert-docs.js` (`npm run check:docs`): links, anchors, required files, and AGENTS.md length. |
