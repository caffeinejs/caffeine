import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import * as std from '@caffeinejs/std'
import { EnvConfigSource } from '@caffeinejs/std/config/env'
import { globbySync } from 'globby'
import { describe, expect, it } from 'vitest'

// Every configuration key a feature declares has to be one an environment variable reaches. `EnvConfigSource`
// lowercases each word of a name and camel-cases the rest, so `CACHE_TTL` becomes `cacheTtl`: a key spelled
// `cacheTTL` is reached by no variable at all, and validation drops the folded one at bootstrap() without a word.
//
// The feature schemas are read from the JSON Schema generated beside each package's `_spectypes/`
// (`make spec`), so a schema added later is covered without touching this file. `make check` fails when that JSON
// is stale.
const root = fileURLToPath(new URL('..', import.meta.url))

const specs = globbySync('**/_spec/*.gen.json', { cwd: root, ignore: ['**/node_modules/**', '**/dist/**'] })

const schemas: Array<[string, unknown]> = [
  ...specs.map((file): [string, unknown] => [file, JSON.parse(readFileSync(`${root}${file}`, 'utf8'))]),
  // The framework's own block, which is not a feature's.
  ['std.caffeineConfigSchema', std.caffeineConfigSchema],
]

interface DeclaredKey {
  path: string
  key: string
}

function keysOf(schema: unknown, path: string): DeclaredKey[] {
  if (typeof schema !== 'object' || schema === null) {
    return []
  }

  const node = schema as {
    properties?: Record<string, unknown>
    patternProperties?: Record<string, unknown>
    additionalProperties?: unknown
    anyOf?: unknown[]
    allOf?: unknown[]
    oneOf?: unknown[]
    items?: unknown
  }
  const found: DeclaredKey[] = []

  for (const [key, child] of Object.entries(node.properties ?? {})) {
    found.push({ path, key }, ...keysOf(child, `${path}.${key}`))
  }

  // A map's keys are the user's to choose, a scheme or a binding name, so only what it holds is the schema's.
  for (const child of [...Object.values(node.patternProperties ?? {}), node.additionalProperties]) {
    found.push(...keysOf(child, `${path}.<name>`))
  }

  for (const child of [...(node.anyOf ?? []), ...(node.allOf ?? []), ...(node.oneOf ?? [])]) {
    found.push(...keysOf(child, path))
  }

  for (const child of [node.items].flat()) {
    found.push(...keysOf(child, `${path}[]`))
  }

  return found
}

// The variable a key is meant to be set by: `cacheTtl` is `CACHE_TTL`, and so, meant or not, is `cacheTTL`.
const variableFor = (key: string): string =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toUpperCase()

const foldedFrom = (variable: string): string[] => {
  const [layer] = new EnvConfigSource({ env: { [`BLOCK__${variable}`]: 'x' } }).load({
    logger: { warn: () => undefined },
  } as never)

  return Object.keys((layer.data as { block: Record<string, unknown> }).block)
}

describe('configuration keys', () => {
  // Without this the guard below passes vacuously the day the generated files move.
  it('are found for every feature', () => {
    expect(specs.length).toBeGreaterThan(10)
  })

  it.each(schemas)('of %s are the ones their environment variables fold to', (name, schema) => {
    const keys = keysOf(schema, name)

    expect(keys.length).toBeGreaterThan(0)

    for (const { path, key } of keys) {
      expect(foldedFrom(variableFor(key)), `${path}.${key}`).toEqual([key])
    }
  })
})
