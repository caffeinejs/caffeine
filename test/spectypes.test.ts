import { readFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { globby } from 'globby'
import { describe, expect, it } from 'vitest'

// A feature's configuration schemas live in its `_spectypes/` directory, one exported schema per file. They describe
// the feature's options; the feature never reads them, and no entry point reaches them for now.

const root = fileURLToPath(new URL('..', import.meta.url))

const NOT_SHIPPED = [
  '**/node_modules/**',
  '**/dist/**',
  '**/_tests/**',
  '**/_testdata/**',
  '**/*.test.ts',
  '**/*.test-d.ts',
  '**/*.spec.ts',
  '**/*.testkit.ts',
  '**/*.e2e.ts',
  '**/vitest.config.ts',
]

const SPECIFIER = /(?:\bimport|\bexport)\s[^'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]/g

const inSpectypes = (file: string): boolean => file.split(sep).includes('_spectypes')

function specifiersOf(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map(match => (match[1] ?? match[2])!)
}

async function shipped(): Promise<string[]> {
  const { workspaces } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { workspaces: string[] }

  return globby(
    workspaces.map(workspace => `${workspace}/**/*.ts`),
    { cwd: root, absolute: true, ignore: NOT_SHIPPED },
  )
}

describe('_spectypes', () => {
  it('is imported by no code a package ships outside it', async () => {
    const offending = (await shipped())
      .filter(file => !inSpectypes(file))
      .flatMap(file =>
        specifiersOf(readFileSync(file, 'utf8'))
          .filter(specifier => specifier.startsWith('.') && inSpectypes(resolve(dirname(file), specifier)))
          .map(specifier => `${file.slice(root.length)} imports ${specifier}`),
      )

    expect(offending).toEqual([])
  })

  // A file may declare several schemas to build the one it exports, but exports only that one: the schema that
  // configures something, which is the one `_spec/` is generated from.
  it('exports exactly one configuration schema per file', async () => {
    const files = (await shipped()).filter(file => inSpectypes(file) && !file.endsWith(`${sep}index.ts`))

    // Without this the check passes vacuously the day the schemas move again.
    expect(files.length).toBeGreaterThan(10)

    const offending = files.flatMap(file => {
      const exported = [
        ...readFileSync(file, 'utf8').matchAll(/^export\s+(?:const|function|class|let|type|interface)\s+(\w+)/gm),
      ].map(match => match[1]!)

      return exported.length === 1 && exported[0]!.endsWith('ConfigSchema')
        ? []
        : [`${file.slice(root.length)} exports ${exported.join(', ') || 'nothing'}`]
    })

    expect(offending).toEqual([])
  })
})
