# Development

## Git Hooks

Run `npm install` or `npm run install:hooks` after cloning to install the Husky
Git hooks from `.husky`.

The pre-commit hook runs `npm run check`, which covers formatting, linting,
type-checking, and release-workflow guardrails.
