# Development

Use Node.js 22.13.0 or newer. GitHub Actions pins 22.13.0 so the tested lower
bound matches `package.json` and the current lint/type-check toolchain.

## Git Hooks

Run `npm install` or `npm run install:hooks` after cloning to install the Husky
Git hooks from `.husky`.

The pre-commit hook runs `npm run check`, which covers formatting, linting,
type-checking, layer boundaries (`assert-layers.js`), doc-drift
(`assert-docs.js`), and package/release guardrails.

## Standalone B2 simulator

Simulator-backed tests (`src/test/suite/lmToolOperations.test.ts` and one test
each in `b2.test.ts` and `listFiles.test.ts`) run against the standalone B2
simulator, [backblaze-labs/b2-simulator](https://github.com/backblaze-labs/b2-simulator),
not the SDK's in-process one. Each suite starts one local server
(`src/test/suite/standaloneSimulatorHooks.ts`), resets it before every test, and
stops it afterwards. Requests never leave the loopback server.

Locally, clone the simulator at v0.6.0 or later and point the tests at it:

```bash
export B2_SIMULATOR_DIR=/absolute/path/to/b2-simulator
npm test
```

In CI, `.github/actions/b2-simulator` checks out the pinned revision with the
`SIMULATOR_DEPLOY_KEY` secret (a read-only deploy key of the simulator
repository). It must exist as an Actions secret and as a Dependabot secret,
because Dependabot pull requests run the required VS Code tests. Pull requests
from forks cannot read the key, so the job refuses them with a message asking
for a branch in this repository. To move to a newer simulator, change the
`revision` default in that action.
