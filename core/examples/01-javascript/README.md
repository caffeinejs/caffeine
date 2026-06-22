# 01 — JavaScript

Manual dependency injection with plain JavaScript. No TypeScript, no decorators — just the DiCaf imperative API.

Demonstrates a simple Todo app wired entirely through string keys and `di.bind()` calls.

## What it shows

- `di.bind(key).toClass(Class, [deps])` — manual class binding
- String keys instead of class or symbol tokens
- `di.get(key)` — resolving instances after `init()`
- Zero-decorator setup: works in any JS environment

## Tech stack

- Node.js (plain JavaScript, ESM)
- `@caffeine-projects/dicaf`

## Run

```sh
npm run start -w @caffeine-projects/example-javascript
```
