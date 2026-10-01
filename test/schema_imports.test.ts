import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { globby } from 'globby'
import { describe, expect, it } from 'vitest'

// A feature's configuration schema describes the feature's options; the feature never reads it. So nothing a package
// ships imports a `schema.ts` that declares a `*ConfigSchema`, and no barrel re-exports one: the schemas are internal
// to their package for now, reached by no entry point.
//
// Tests are exempt, and so is a schema importing another schema's building blocks. A feature schema is told apart by
// its PascalCase `*ConfigSchema` export: `std/config/schema.ts` is the configuration machinery's own.

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

function specifiersOf(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map(match => (match[1] ?? match[2])!)
}

describe('configuration schemas', () => {
  it('are imported by no code a package ships', async () => {
    const workspaces = (JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { workspaces: string[] })
      .workspaces
    const files = await globby(
      workspaces.map(workspace => `${workspace}/**/*.ts`),
      { cwd: root, absolute: true, ignore: NOT_SHIPPED },
    )

    const schemaFiles = new Set(
      files.filter(
        file => file.endsWith('/schema.ts') && /export const [A-Z]\w*ConfigSchema\b/.test(readFileSync(file, 'utf8')),
      ),
    )

    // Without this the check passes vacuously the day the schemas move again.
    expect(schemaFiles.size).toBeGreaterThan(10)

    const offending = files
      .filter(file => !schemaFiles.has(file))
      .flatMap(file =>
        specifiersOf(readFileSync(file, 'utf8'))
          .filter(
            specifier =>
              specifier.startsWith('.') && schemaFiles.has(resolve(dirname(file), specifier).replace(/\.js$/, '.ts')),
          )
          .map(specifier => `${file.slice(root.length)} imports ${specifier}`),
      )

    expect(offending).toEqual([])
  })
})
