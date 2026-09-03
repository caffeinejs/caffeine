---
sidebar_label: Auto Load Decorated Classes
---

# Auto Load Decorated Classes

When using decorators, every file containing an `@Injectable` or
`@Configuration` class must be imported before the container is created.
CaffeineIoC's `scan()` function automates this: it recursively imports all source
files in a directory so their decorators register themselves, without you
having to maintain a manual import list.

`scan()` is available from the main package import in Node.js environments:

```ts
import { scan } from '@caffeinejs/di'
```

## Basic usage

```ts
import { fileURLToPath } from 'node:url'
import { CaffeineIoC, scan } from '@caffeinejs/di'

const rootDir = fileURLToPath(new URL('.', import.meta.url))

await scan({ dir: rootDir, exclude: import.meta.url })

const di = new CaffeineIoC()
await di.init()
```

`scan()` returns a `Promise<string[]>` with the list of files it imported.
It must be awaited before `new CaffeineIoC()`.

Always exclude the file that calls `scan()`. If `scan()` lives in a dedicated
module (e.g. `app.container.ts`) rather than the process entry point, exclude
both files so neither is imported a second time:

```ts
// app.container.ts
const rootDir = fileURLToPath(new URL('.', import.meta.url))

await scan({
  dir: rootDir,
  exclude: [
    import.meta.url, // app.container.ts itself
    new URL('./index.ts', import.meta.url), // process entry point
  ],
})
```

## Options

```ts
type ScanOptions = {
  dir: string // root directory to scan (required)
  exclude?: string | URL | (string | URL)[] // paths to exclude
  matchFilter?: PathFilter // include only paths matching this filter
  ignoreFilter?: PathFilter // exclude paths matching this filter
  ignorePattern?: RegExp // exclude file/dir names matching this pattern
  scriptPattern?: RegExp // custom file extension pattern
  maxDepth?: number // default: Infinity
  forceESM?: boolean // default: true
}
```

**`dir`** — the root directory to scan. Use an absolute path.

**`exclude`** — one or more absolute paths to skip entirely. Useful for
excluding the entry file itself:

```ts
await scan({ dir: rootDir, exclude: import.meta.url })
```

**`matchFilter`** — include only files whose path satisfies this filter.
Accepts a glob string, a `RegExp`, a predicate function, or an array of these:

```ts
await scan({ dir: rootDir, matchFilter: /services\// })
await scan({ dir: rootDir, matchFilter: path => path.includes('/services/') })
```

**`ignoreFilter`** — exclude files whose path satisfies this filter.

**`ignorePattern`** — a `RegExp` tested against each file and directory
_name_ (not the full path). Directories matching this pattern are not
descended into. Defaults to `/^\.|^node_modules$/u` (dotfiles and
`node_modules`).

**`scriptPattern`** — override the file extension pattern. By default, scan
matches `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` while
skipping `.d.ts` declaration files and test files (`.spec`, `.test`,
`.e2e`, `.bench`, `_test`).

**`maxDepth`** — limit the recursion depth. `1` means only the top-level
directory.

**`forceESM`** — when `true` (the default), files are imported as ES modules
regardless of the project's `package.json` `"type"` field. Set to `false` if
you have a CommonJS project and import failures occur.

## File-list overload

Pass a list of file paths directly to import only those files:

```ts
import { scan } from '@caffeinejs/di'

const files = ['./services/user.js', './services/order.js']
await scan(files)
```

The second argument accepts `Pick<ScanOptions, 'forceESM'>` if you need to
control the module format:

```ts
await scan(files, { forceESM: false })
```

Because the file-list overload accepts any `string | string[] | Promise<string | string[]>`, you can use any glob
library to produce the list. For example, with
[globby](https://github.com/sindresorhus/globby):

```ts
import { scan } from '@caffeinejs/di'
import { globby } from 'globby'

await scan(globby('src/services/**/*.js'))
```

## CommonJS projects

For CommonJS projects set `forceESM: false` so the loader respects your
`package.json` `"type": "commonjs"`:

```ts
await scan({ dir: rootDir, forceESM: false })
```

## Troubleshooting

### Warning: Detected unsettled top-level await at \<filename\>

Node.js emits this warning when `scan()` re-imports a file that itself contains
a top-level `await` — typically the file that called `scan()` or the process
entry point. The import triggers a second evaluation of that `await`, which
Node.js flags as unsettled.

Fix: exclude both the file that called the `scan` and the application entry point.

If `scan()` is in the entry point:

```ts
await scan({ dir: rootDir, exclude: import.meta.url })
```

If `scan()` is in a separate module (e.g. `app.container.ts`) that is imported
by an entry point (e.g. `index.ts`), exclude both:

```ts
await scan({
  dir: rootDir,
  exclude: [import.meta.url, new URL('./index.ts', import.meta.url)],
})
```

---

## What scan does not do

- It does not watch for file changes. For hot-reload scenarios, restart the
  process or call `scan()` again followed by container recreation.
- It does not load TypeScript files directly. Scan operates on the compiled
  output. Attempting to load a `.ts` file throws `ErrCannotLoadTypeScriptModule`.
- It does not provide fine-grained control over load order. If load order
  matters, import files manually in the required sequence and pass the list to
  the file-list overload.
