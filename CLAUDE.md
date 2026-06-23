# Claude Code Guidelines

## Import style

Group all imports from the same module into a single import statement. Do not split them across multiple lines. This is enforced by `import-x/no-duplicates`.

```ts
// correct
import { Binder, BindTo } from './Binder.js'

// wrong
import { Binder } from './Binder.js'
import { BindTo } from './Binder.js'
```

## After every edit

After making any code changes, always run the following checks in order and fix any failures before considering the task complete:

1. `npm run build` — must compile without errors
2. `npm run test:typecheck` — type-check all test files
3. `npm run test:typecheck:legacy` — type-check legacy decorator files
4. `npm test` — all tests must pass
5. `npm run lint:fix` — zero errors (warnings are pre-existing and acceptable)

## Private modules

Files prefixed with `_` (e.g., `_noop.ts`) are private to their directory. Do not import them from a different directory. This is enforced by the `no-restricted-imports` ESLint rule.

```ts
// correct — same directory
import { noop } from './_noop.js'

// wrong — cross-directory
import { noop } from '../_noop.js'
```

## Error messages

- Sentence case: start with a capital letter
- No trailing period
- No contractions: `does not` not `doesn't`, `could not` not `couldn't`
- Active voice: `Cannot X` not `Unable to X` or `Failed to X`
- Colon for detail: `Cannot do X: reason` not `Cannot do X. Reason.`
- Double-quote user-supplied values: `"${keyStr(key)}"` not `'${keyStr(key)}'`
- Name error classes with the `Err` prefix: `ErrNoResolutionForKey`, not `NoResolutionForKeyError`. This follows the Rust/Go convention — a deliberate choice diverging from the JS `SomethingError` suffix norm.
- The `.name` property and `code` string must align with the class name: `ErrFoo` → `this.name = 'ErrFoo'`, `code = 'ERR_FOO'`
- Errors with fixed, context-free solutions may call `solutions()` inside their constructor. Contextual errors with variable message content call `solutions()` at the throw site.

## Import extensions

All imports must include the `.js` extension, including TypeScript source files.

```ts
// correct
import { DiCaf } from './container.js'
import { Binding } from './binding.js'

// wrong
import { DiCaf } from './container'
import { Binding } from './Binding'
```

## Monorepo structure

Packages: `core` (`@caffeinejs/core`), `http` (`@caffeinejs/http`), `http-fastify-adapter` (`@caffeinejs/http-fastify-adapter`). Examples live under `examples/`. Shared build tooling lives in `tools/`.

Cross-package imports use the package name, not relative paths across workspace boundaries.

```ts
// correct — from http package
import { DiCaf } from '@caffeinejs/core'

// wrong — leaks internal paths
import { DiCaf } from '../core/container.js'
```

## Build system

- `npm run build` at the root compiles all packages via `tsc --build` (project references) then runs `build:cjs` per workspace to emit CommonJS output via esbuild.
- ESM output lands in `dist/esm/`, CJS in `dist/commonjs/`.
- Do not edit `dist/` by hand.
