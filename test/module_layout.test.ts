import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { globby } from 'globby'
import { describe, expect, it } from 'vitest'

// A module is found by its barrel: what a package publishes from a directory is what that directory's `index.ts`
// re-exports, and a reader looks nowhere else. A directory of source files without one is either a module missing its
// barrel or files that belong in the directory above it.

const root = fileURLToPath(new URL('..', import.meta.url))

// Not library packages: no module layout applies to them. `cli/` is the `caffeine` command and its scaffolding
// templates, not a library of modules.
const NO_MODULE_LAYOUT = [
  'benchmarks/**',
  'examples/**',
  'di/examples/**',
  'devtools-ui/**',
  'cli/**',
  '**/node_modules/**',
  '**/dist/**',
]

// Files a package does not ship as source: tests, their kits and test configuration.
const NOT_SOURCE = /\.(?:test|test-d|spec|e2e|testkit)\.ts$|(?:^|\/)vitest(?:\.\w+)?\.config\.ts$/

const isPrivate = (path: string): boolean => path.split('/').some(segment => segment.startsWith('_'))

async function modulesWithoutBarrel(): Promise<{ directories: number; found: string[] }> {
  const { workspaces } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { workspaces: string[] }
  // A workspace may be a pattern (`plugins/*`): a package root is a directory holding a `package.json`.
  const packages = new Set(
    (
      await globby(
        workspaces.map(workspace => `${workspace}/package.json`),
        { cwd: root, ignore: NO_MODULE_LAYOUT },
      )
    ).map(file => dirname(file)),
  )
  const sources = (
    await globby(
      workspaces.map(workspace => `${workspace}/**/*.ts`),
      { cwd: root, ignore: NO_MODULE_LAYOUT },
    )
  ).filter(file => !NOT_SOURCE.test(file))

  const directories = new Set(sources.map(file => dirname(file)))
  const barrels = new Set(sources.filter(file => file.endsWith('/index.ts')).map(file => dirname(file)))

  // A package root is exempt: its `index.ts` is the entry, and `std/` has none.
  const found = [...directories].filter(dir => !packages.has(dir) && !isPrivate(dir) && !barrels.has(dir)).toSorted()

  return { directories: directories.size, found }
}

describe('module layout', () => {
  it('gives every module of a library package its barrel', async () => {
    const { directories, found } = await modulesWithoutBarrel()

    expect(found).toEqual([])
    expect(directories).toBeGreaterThan(100)
  })
})
