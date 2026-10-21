import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { globby } from 'globby'
import { describe, expect, it } from 'vitest'

// A `_` module is private to its directory, so nothing outside the package can import what it declares. A declaration
// the package ships that takes or returns one of its types hands users a type they cannot name: the type belongs in a
// public module. A bare `import './_x.js'` is a side effect (a module augmentation, a polyfill) and names nothing.

const root = fileURLToPath(new URL('..', import.meta.url))

// Not library packages: their output is not a published surface.
const NOT_LIBRARIES = ['benchmarks/**', 'examples/**', 'di/examples/**', 'devtools/ui/**', '**/node_modules/**']

// Shipped declarations that already name a private module's type, most of them in a signature users meet. A line is a
// file and the module it imports from: moving that module's types to a public one removes the line, and no line may
// be added.
const GRANDFATHERED = [
  'distlock/dist/distlock.d.ts imports ./_lock.js',
  'http/dist/core/routing/programmatic/flatten.d.ts imports ./_state.js',
  'http/dist/core/routing/programmatic/route_chain.d.ts imports ./_state.js',
  'http/dist/core/routing/programmatic/scoped_plugins.d.ts imports ./_state.js',
  'http/dist/core/routing/programmatic/source.d.ts imports ./_state.js',
  'http/dist/decorators/args.d.ts imports ./_params.js',
  'http/dist/decorators/verbs.d.ts imports ./_params.js',
  'testing/dist/http/test_client.d.ts imports ./_test_app.js',
]

// `import { A, type B } from '…'`, `import type { A } from '…'`, `export * from '…'`: a statement that names
// something. A bare `import '…'` does not match.
const NAMING =
  /^(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+(?:\s*,\s*\{[^}]*\})?)\s+from\s+['"]([^'"]+)['"]/gm

// `import('./_x.js').T`: the form `tsc` writes for an inferred type, with no import statement at all.
const INLINE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g

const isPrivate = (path: string): boolean => path.split(/[\\/]/).some(segment => segment.startsWith('_'))

async function publicDeclarations(): Promise<string[]> {
  const { workspaces } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { workspaces: string[] }
  const declarations = await globby(
    workspaces.map(workspace => `${workspace}/dist/**/*.d.ts`),
    { cwd: root, ignore: NOT_LIBRARIES },
  )

  return declarations.filter(file => !isPrivate(file))
}

async function leaks(): Promise<{ files: number; found: string[] }> {
  const files = await publicDeclarations()
  const found = files.flatMap(file => {
    const declaration = readFileSync(resolve(root, file), 'utf8')

    return [...declaration.matchAll(NAMING), ...declaration.matchAll(INLINE)]
      .map(match => match[1]!)
      .filter(specifier => specifier.startsWith('.') && isPrivate(specifier))
      .map(specifier => `${file} imports ${specifier}`)
  })

  return { files: files.length, found: [...new Set(found)].toSorted() }
}

describe('private modules', () => {
  it('lend no type to a shipped declaration', async () => {
    const { files, found } = await leaks()

    expect(found.filter(leak => !GRANDFATHERED.includes(leak))).toEqual([])
    expect(files).toBeGreaterThan(500)
  })

  // A fixed leak still listed would let a new one take its place unseen.
  it('keep the grandfathered list to leaks that still exist', async () => {
    const { found } = await leaks()

    expect(GRANDFATHERED.filter(leak => !found.includes(leak))).toEqual([])
  })
})
