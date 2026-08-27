# Core beliefs

Agent-first operating principles for **b2-vscode**. These are the "why" behind
[`AGENTS.md`](../../AGENTS.md); the full rationale is in
[`references/harness-engineering.md`](../references/harness-engineering.md).

1. **Humans steer; agents execute.** People set intent, acceptance criteria, and
   taste. Agents build. When output is wrong, fix the environment, not the prompt.
2. **The repo is the system of record.** If an agent can't see it in-repo while
   running, it doesn't exist. Push context in; kill tribal knowledge.
3. **A map, not a manual.** [`AGENTS.md`](../../AGENTS.md) stays ~100 lines and
   points to the real docs. Progressive disclosure beats one giant file.
4. **Enforce invariants, not implementations.** Constrain _shapes_ (layers,
   boundaries, "parse at the edge") and let the agent choose the how. See
   [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md).
5. **Promote rules into code.** When a doc rule keeps being missed, make it a
   `scripts/assert-*.js` check whose failure message says how to fix it.
6. **Prefer boring, internalizable tech.** All B2 access goes through one typed
   SDK (`@backblaze-labs/b2-sdk`); in-repo helpers stay small and well-tested.
7. **Safety is a boundary property.** Validate paths and inputs at the edge
   (`services/pathSafety.ts`, `tools/*` path helpers) before any I/O or B2 call.
   Never build on guessed data shapes.
8. **Plans and tech debt are first-class.** Non-trivial work gets an exec plan;
   deferrals get logged in the [tech-debt tracker](../exec-plans/tech-debt-tracker.md).
9. **Pay debt down continuously** in small increments, not painful bursts.
10. **Write concise docs.** Every token competes with the task. Too much
    guidance becomes non-guidance.
