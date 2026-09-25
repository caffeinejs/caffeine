import * as distlock from '@caffeinejs/distlock'
import * as http from '@caffeinejs/http'
import * as kafka from '@caffeinejs/kafka'
import * as messaging from '@caffeinejs/messaging'
import * as openapi from '@caffeinejs/openapi'
import * as staticFiles from '@caffeinejs/static'
import * as std from '@caffeinejs/std'
import { EnvConfigSource } from '@caffeinejs/std/config'
import * as logger from '@caffeinejs/std/logger'
import * as shutdown from '@caffeinejs/std/shutdown'
import { describe, expect, it } from 'vitest'

// Every configuration key a feature declares has to be one an environment variable reaches. `EnvConfigSource`
// lowercases each word of a name and camel-cases the rest, so `CACHE_TTL` becomes `cacheTtl`: a key spelled
// `cacheTTL` is reached by no variable at all, and validation drops the folded one at ready() without a word.
//
// Schemas are found by name, every `*ConfigSchema` an entry point exports, so one added later is covered without
// touching this file. A package that starts declaring configuration adds its entry point here.
const entryPoints: Record<string, object> = {
  distlock,
  http,
  kafka,
  logger,
  messaging,
  openapi,
  shutdown,
  static: staticFiles,
  std,
}

const schemas: Array<[string, unknown]> = [
  ...Object.entries(entryPoints).flatMap(([entry, exports]) =>
    Object.entries(exports)
      .filter(([name]) => name.endsWith('ConfigSchema'))
      .map(([name, schema]): [string, unknown] => [`${entry}.${name}`, schema]),
  ),
  // The blocks under `auth.schemes.<name>`, one per scheme kind, which an application splices in by hand.
  ...Object.entries(http.SCHEME_SCHEMAS).map(([kind, schema]): [string, unknown] => [
    `http.SCHEME_SCHEMAS.${kind}`,
    schema,
  ]),
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
  // Without this the guard below passes vacuously for an entry point whose schema was renamed or stopped being
  // exported.
  it.each(Object.keys(entryPoints))('are declared by %s', entry => {
    expect(schemas.some(([name]) => name.startsWith(`${entry}.`))).toBe(true)
  })

  it.each(schemas)('of %s are the ones their environment variables fold to', (name, schema) => {
    const keys = keysOf(schema, name)

    expect(keys.length).toBeGreaterThan(0)

    for (const { path, key } of keys) {
      expect(foldedFrom(variableFor(key)), `${path}.${key}`).toEqual([key])
    }
  })
})
