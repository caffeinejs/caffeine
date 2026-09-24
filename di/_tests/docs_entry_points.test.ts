import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * Every `@caffeinejs/*` specifier a doc tells a reader to import has to be one the package actually exports.
 * `@caffeinejs/di/decorators` and `@caffeinejs/di/decorators/legacy` were cited across twenty pages and
 * neither has ever existed — copied into an application, they fail at install or at resolve, and nothing in
 * the build noticed because a fenced code block is not compiled.
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const repo = join(here, '..', '..')
const docs = join(here, '..', 'docs')

const IMPORT_RE = /from\s+'(@caffeinejs\/[^']+)'/g

/** `@scope/name` from `@scope/name/sub/path`. */
function packageOf(specifier: string): string {
  return specifier.split('/').slice(0, 2).join('/')
}

function subpathOf(specifier: string): string {
  const rest = specifier.split('/').slice(2).join('/')
  return rest === '' ? '.' : `./${rest}`
}

function directoryOf(pkg: string): string {
  // The workspace directory matching a package name, e.g. `@caffeinejs/di` -> `di`.
  return pkg.slice('@caffeinejs/'.length)
}

function exportedSubpaths(pkg: string): string[] {
  const manifest = JSON.parse(readFileSync(join(repo, directoryOf(pkg), 'package.json'), 'utf8')) as {
    exports: Record<string, unknown>
  }

  return Object.keys(manifest.exports)
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory()
      ? markdownFiles(join(dir, entry.name))
      : entry.name.endsWith('.md')
        ? [join(dir, entry.name)]
        : [],
  )
}

describe('the entry points di/docs tells a reader to import', () => {
  const cited = markdownFiles(docs).flatMap(file => {
    const text = readFileSync(file, 'utf8')
    return [...text.matchAll(IMPORT_RE)].map(match => ({
      file: file.slice(repo.length + 1),
      specifier: match[1],
    }))
  })

  it('finds imports to check, so a silent zero cannot pass for a clean result', () => {
    expect(cited.length).toBeGreaterThan(20)
  })

  it('names only subpaths the package exports', () => {
    const offenders = cited.filter(({ specifier }) => {
      const pkg = packageOf(specifier)
      return !exportedSubpaths(pkg).includes(subpathOf(specifier))
    })

    expect(offenders.map(o => `${o.file}: ${o.specifier}`)).toEqual([])
  })
})
