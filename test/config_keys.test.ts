import * as std from '@caffeinejs/std'
import { EnvConfigSource } from '@caffeinejs/std/config/env'
import { describe, expect, it } from 'vitest'

import * as caching from '../caching/dist/schema.js'
import * as devtools from '../devtools/dist/schema.js'
import * as distlock from '../distlock/dist/schema.js'
import * as html from '../html/dist/schema.js'
import * as http from '../http/dist/schema.js'
import * as typeorm from '../integrations/typeorm/dist/schema.js'
import * as kafka from '../kafka/dist/schema.js'
import * as messaging from '../messaging/dist/schema.js'
import * as multipart from '../multipart/dist/schema.js'
import * as openapi from '../openapi/dist/schema.js'
import * as staticFiles from '../static/dist/schema.js'
import * as logger from '../std/dist/logger/schema.js'
import * as shutdown from '../std/dist/shutdown/schema.js'
import * as view from '../view/dist/schema.js'

// Every configuration key a feature declares has to be one an environment variable reaches. `EnvConfigSource`
// lowercases each word of a name and camel-cases the rest, so `CACHE_TTL` becomes `cacheTtl`: a key spelled
// `cacheTTL` is reached by no variable at all, and validation drops the folded one at bootstrap() without a word.
//
// Schemas are found by name, every `*ConfigSchema` a schema module exports, so one added later is covered without
// touching this file. A package that starts declaring configuration adds its `schema.ts` here. The schemas are not
// published through a package subpath yet, so each is read from the package's build output.
const entryPoints: Record<string, object> = {
  caching,
  devtools,
  distlock,
  html,
  http,
  kafka,
  logger,
  messaging,
  multipart,
  openapi,
  shutdown,
  static: staticFiles,
  std,
  typeorm,
  view,
}

const schemas: Array<[string, unknown]> = Object.entries(entryPoints).flatMap(([entry, exports]) =>
  Object.entries(exports)
    .filter(([name]) => name.endsWith('ConfigSchema'))
    .map(([name, schema]): [string, unknown] => [`${entry}.${name}`, schema]),
)

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
