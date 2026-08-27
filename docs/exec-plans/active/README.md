# Active execution plans

In-flight plans for non-trivial work. Each plan is a checked-in markdown file
with acceptance criteria, a progress checklist, and a decision log, so an agent
can resume it without external context.

Small changes don't need a plan — they're ephemeral. A plan is warranted when
work spans multiple PRs, touches several domains, or carries meaningful risk.

**Lifecycle:** `active/` → move to [`../completed/`](../completed/) when shipped.
Deferred sub-work is logged in
[`../tech-debt-tracker.md`](../tech-debt-tracker.md).

Naming: `YYYY-MM-<slug>.md` (e.g. `2026-09-object-lock.md`).
