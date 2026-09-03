---
sidebar_label: Decorators
---

# Decorators

CaffeineIoC ships two decorator flavours. Choosing the wrong one — or mixing both — causes
runtime errors that are hard to trace. This guide explains the difference, how to set
each one up, and how to enforce consistency with ESLint.

For the full decorator API, see the [Decorators reference](../reference/decorators.md).

---

## ECMAScript stage 3 (recommended)

Standard TC39 decorators, available in TypeScript 5.0+. No `reflect-metadata` polyfill
required. Import from the main subpath:

```ts
import { Injectable, Lifetime, Scopes } from '@caffeinejs/di/decorators'
```

### TypeScript config

```json
{
  "compilerOptions": {
    "target": "ES2022"
  }
}
```

`experimentalDecorators` must be absent or `false`. TypeScript 5 enables stage 3
decorators by default.

### Declaring dependencies

Stage 3 decorators do not emit constructor parameter metadata. Dependencies must be
declared explicitly in the `@Injectable` array:

```ts
@Injectable([Logger, Database])
class UserService {
  constructor(
    private readonly logger: Logger,
    private readonly db: Database,
  ) {}
}
```

---

## Legacy TypeScript decorators

Uses TypeScript's `experimentalDecorators` flag and the `reflect-metadata` polyfill.
Import from the legacy subpath:

```ts
import { Injectable, Lifetime, Scopes } from '@caffeinejs/di/decorators/legacy'
```

### TypeScript config

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

### Setup

Install `reflect-metadata` and import it once at your application entry point before
any CaffeineIoC code runs:

```sh
npm install reflect-metadata
```

```ts
// main.ts — must be first
import 'reflect-metadata'
```

### Declaring dependencies

With `emitDecoratorMetadata: true`, the compiler emits constructor parameter types as
metadata. CaffeineIoC reads this at startup so you do not need an explicit dependency list:

```ts
@Injectable()
class UserService {
  // Logger and Database inferred automatically from the parameter types
  constructor(
    private readonly logger: Logger,
    private readonly db: Database,
  ) {}
}
```

---

## Do not mix both flavours

Stage 3 and legacy decorators are not compatible. Importing from both subpaths in
the same project will produce undefined behaviour: metadata will be read by the wrong
reader, decorators will silently no-op, or the container will fail to resolve bindings.

```ts
// wrong — never mix these two imports
import { Injectable } from '@caffeinejs/di/decorators'
import { Lifetime } from '@caffeinejs/di/decorators/legacy'
```

Pick one flavour per project and use it consistently across every file.

---

## Enforcing consistency with ESLint

To prevent import-path mixing, add an `import-x/no-restricted-paths` (or equivalent)
rule pointing at the subpath you are not using:

```js
// eslint.config.js — stage 3 project: ban the legacy subpath
rules: {
  'no-restricted-imports': ['error', {
    patterns: ['@caffeinejs/di/decorators/legacy*'],
  }],
}

// eslint.config.js — legacy project: ban the stage 3 subpath
rules: {
  'no-restricted-imports': ['error', {
    patterns: ['@caffeinejs/di/decorators', '!@caffeinejs/di/decorators/legacy'],
  }],
}
```

---

## Which flavour to choose

|                    | Stage 3      | Legacy   |
| ------------------ | ------------ | -------- |
| TypeScript version | 5.0+         | any      |
| `reflect-metadata` | not required | required |
| Explicit dep list  | required     | optional |
| Long-term standard | yes          | no       |

Choose stage 3 for new projects. Use legacy only when migrating an existing codebase
that already relies on `experimentalDecorators` and implicit injection.
