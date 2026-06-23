# Development

Use Node.js 22.13.0 or newer. GitHub Actions pins 22.13.0 so the tested lower
bound matches `package.json` and the current lint/type-check toolchain.

## Git Hooks

Run `npm install` or `npm run install:hooks` after cloning to install the Husky
Git hooks from `.husky`.

The pre-commit hook runs `npm run check`, which covers formatting, linting,
type-checking, and release-workflow guardrails.
