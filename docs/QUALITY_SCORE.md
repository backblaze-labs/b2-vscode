# Quality score

A coarse, honest grade per layer/area, plus the gaps behind each grade, tracked
over time. Grades are directional (are we improving?), not precise. Update on a
cadence and when a gap closes.

**Scale:** A (strong, enforced) · B (good, minor gaps) · C (works, real gaps) ·
D (fragile / unenforced).

| Area                              | Grade | Basis                                                                                                | Gaps                                                                                                                                                                                     |
| --------------------------------- | ----- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Utils / Types                     | A     | Pure, small, well-tested helpers; purity enforced by `assert-layers.js`                              | —                                                                                                                                                                                        |
| Services                          | B     | Clear boundaries; path-safety + transfer safety are tested                                           | Transfer facade is broad ([transfer-architecture](transfer-architecture.md))                                                                                                             |
| Integration (commands/tools/tree) | B     | Commands, tree, and LM tools are covered by the VS Code test suite                                   | Growing feature surface needs the submenu/IA restructure ([#102](https://github.com/backblaze-labs/b2-vscode/issues/102)/[#104](https://github.com/backblaze-labs/b2-vscode/issues/104)) |
| Harness (scripts / CI)            | A     | Extensive `assert-*` gates, audit policy, VSIX + release contracts, `npm run check` mirrors CI       | Layering + docs now enforced (`assert-layers.js`, `assert-docs.js`)                                                                                                                      |
| Docs (system of record)           | A     | `AGENTS.md` map + structured `docs/`; links/anchors/length enforced by `assert-docs.js`              | —                                                                                                                                                                                        |
| Security posture                  | A     | Threat model documented; confirmations on destructive/exposing actions; hardened install/audit gates | Ongoing — see [`../SECURITY.md`](../SECURITY.md)                                                                                                                                         |

## How to use this

- A grade drop is a signal to file a [tech-debt entry](exec-plans/tech-debt-tracker.md)
  or an [exec plan](exec-plans/active/), not to panic.
- Prefer closing gaps by **promoting rules into checks** so the grade is
  self-defending, not re-graded by opinion each time.
