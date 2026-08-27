# Generated references

Machine-generated docs that are verified and (where useful) checked in. Do not
hand-edit generated files — change the generator and regenerate.

| Reference               | Generator          | Output                                                             |
| ----------------------- | ------------------ | ------------------------------------------------------------------ |
| API reference (typedoc) | `npm run api-docs` | `api-docs/` (git-ignored; built in CI and uploaded as an artifact) |

The API reference is **not** committed — it is regenerated from `src/` on every
`main` push and PR by [`.github/workflows/docs.yml`](../../.github/workflows/docs.yml)
and configured in [`../../typedoc.json`](../../typedoc.json).

When a future reference is worth committing (e.g. a generated command/tool
surface table derived from `package.json` `contributes`), add its generator to
`scripts/` and a row above, and gate regeneration in CI so it can't drift.
