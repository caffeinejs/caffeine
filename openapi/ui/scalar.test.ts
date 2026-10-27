import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import type * as nodeModule from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ErrOpenAPIConfiguration } from '../errors.js'
import { readScalarBundle, scalarPage } from './scalar.js'

// Where `@scalar/api-reference` resolves to, standing in for what is installed. `undefined` is "not installed".
let resolved: string | undefined

vi.mock('node:module', async original =>
  Object.assign({}, await original<typeof nodeModule>(), {
    createRequire: () => ({
      resolve: () => {
        if (resolved === undefined) {
          throw new Error("Cannot find module '@scalar/api-reference'")
        }
        return resolved
      },
    }),
  }),
)

function packageDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'caffeine-scalar-'))
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), contents)
  }
  return dir
}

describe('readScalarBundle', () => {
  afterEach(() => {
    resolved = undefined
  })

  // The peer dependency is optional, so its absence is a start-up failure that names both ways out.
  it('refuses to serve the UI when the package is not installed', () => {
    expect(readScalarBundle).toThrow(ErrOpenAPIConfiguration)
    expect(readScalarBundle).toThrow(
      'Cannot serve the OpenAPI documentation UI: "@scalar/api-reference" is not installed',
    )
    expect(readScalarBundle).toThrow('Call .docs(false) on the OpenAPI builder')
  })

  // Scalar has moved the bundle between releases; every known location is tried before giving up.
  it('reads the bundle from a later known location when the first is absent', () => {
    const dir = packageDir({ 'dist/standalone.js': 'bundle-at-root' })
    resolved = join(dir, 'dist', 'index.js')

    expect(readScalarBundle()).toBe('bundle-at-root')
  })

  it('refuses to serve the UI when no known location holds the bundle', () => {
    const dir = packageDir({ 'dist/index.js': '' })
    resolved = join(dir, 'dist', 'index.js')

    expect(readScalarBundle).toThrow(
      `the standalone browser bundle was not found under "${join(dir, 'dist')}" — the package layout may have changed`,
    )
  })
})

describe('scalarPage', () => {
  // The title and URLs come from configuration; unescaped, a quote in a title would break out of the attribute.
  it('escapes what it interpolates into the page', () => {
    const page = scalarPage({ title: '<Pets & "Co">', specURL: '/openapi.json', assetURL: '/docs/_scalar.js' })

    expect(page).toContain('<title>&lt;Pets &amp; &quot;Co&quot;&gt;</title>')
  })

  // An empty proxy keeps "Try it" requests, and their credentials, in the browser.
  it('sends requests straight from the browser unless the application says otherwise', () => {
    const page = scalarPage({
      title: 'API',
      specURL: '/openapi.json',
      assetURL: '/a.js',
      configuration: { theme: 'moon' },
    })

    expect(page).toContain(
      'data-configuration="{&quot;proxyUrl&quot;:&quot;&quot;,&quot;theme&quot;:&quot;moon&quot;}"',
    )
  })
})
