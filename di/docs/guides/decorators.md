---
sidebar_label: Decorators
---

# Decorators

CaffeineIoC uses standard TC39 (stage 3) decorators, available in TypeScript 5.0+. No
`reflect-metadata` polyfill and no `experimentalDecorators` flag. This guide covers the
setup; for the full decorator API, see the [Decorators reference](../reference/decorators.md).

A library that ships only TypeScript's legacy decorators — TypeORM, class-validator — cannot
share a program with these. See [Mixing legacy and TC39 decorators](../../../ai/docs/mixing-decorators.md)
for what to do about it.

---

## TypeScript config

```json
{
  "compilerOptions": {
    "target": "ES2022"
  }
}
```

`experimentalDecorators` must be absent or `false`. TypeScript 5 enables stage 3
decorators by default.

---

## Declaring dependencies

Stage 3 decorators do not emit constructor parameter metadata. Dependencies must be
declared explicitly in the `@Injectable` array:

```ts
import { Injectable } from '@caffeinejs/di'

@Injectable([Logger, Database])
class UserService {
  constructor(
    private readonly logger: Logger,
    private readonly db: Database,
  ) {}
}
```
