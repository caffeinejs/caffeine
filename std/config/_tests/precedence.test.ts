import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { $t } from '../../schema/t.js'
import { loadConfig } from '../load.js'
import { expandKeys } from '../merge.js'
import { ArgsConfigSource } from '../sources/args_source.js'
import { EnvConfigSource } from '../sources/env_source.js'
import { FileConfigSource } from '../sources/file_source.js'
import { InlineConfigSource } from '../sources/inline_source.js'
import { JSONConfigSource } from '../sources/json_source.js'
import type { ConfigSchema, ConfigSource } from '../types.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'caffeine-precedence-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function write(name: string, content: string): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, content, 'utf8')
  return path
}

function definition<T>(sources: ConfigSource[], schema: ConfigSchema<T>) {
  return { schema, key: undefined, storeKey: undefined, sources, loadTimeoutMs: 30_000 }
}

// `server` is set in every scenario. `db` and `app` may be absent from every source, so they carry a default.
const schema = z.object({
  server: z.object({ port: z.coerce.number(), host: z.string() }),
  db: z.object({ url: z.string() }).default({ url: '' }),
  app: z.object({ name: z.string() }).default({ name: 'default-app' }),
})

type App = z.infer<typeof schema>

describe('precedence and provenance across sources', () => {
  // server.host: env, file and inline. server.port: file and inline. db.url: inline only. app.name: nowhere.
  async function sources() {
    const file = await write('multi.json', JSON.stringify({ server: { port: 8080, host: 'file-host' } }))
    return {
      env: new EnvConfigSource({ prefix: 'APP_', env: { APP_SERVER__HOST: 'env-host' } }),
      file: new JSONConfigSource(file),
      inline: new InlineConfigSource({ server: { port: 3000, host: 'inline-host' }, db: { url: 'inline-url' } }),
    }
  }

  it('takes each value from the latest source that has it', async () => {
    const s = await sources()

    // Least to most authoritative: the last one registered wins a conflicting value.
    const store = await loadConfig<App>(definition([s.inline, s.file, s.env], schema))

    expect(store.current.server.host).toBe('env-host')
    expect(store.explain('server.host').layers[0].origin).toBe('env:APP_SERVER__HOST')

    expect(store.current.server.port).toBe(8080)
    expect(store.explain('server.port').layers[0].origin).toMatch(/^file:/)

    expect(store.current.db.url).toBe('inline-url')
    expect(store.explain('db.url').layers[0].origin).toBe('inline')

    // Nowhere: the schema's default, and no layer to show for it.
    expect(store.current.app.name).toBe('default-app')
    expect(store.explain('app.name').layers).toEqual([])
  })

  it('changes the winner when the sources are reordered', async () => {
    const s = await sources()

    const store = await loadConfig<App>(definition([s.env, s.file, s.inline], schema))

    expect(store.current.server.host).toBe('inline-host')
    expect(store.current.server.port).toBe(3000)
    expect(store.explain('server.port').layers.map(l => l.origin)).toEqual(['inline', expect.stringMatching(/^file:/)])
  })

  // std parses JSON and nothing else; every other format is a parse function the application already has.
  it('loads a format std does not know, from the parser the caller supplies', async () => {
    const path = await write('multi.ini', 'server.host=ini-host\nserver.port=9090\n')
    const ini = (text: string) =>
      expandKeys(
        Object.fromEntries(
          text
            .split('\n')
            .filter(line => line !== '')
            .map(line => line.split('=') as [string, string]),
        ),
      )

    const store = await loadConfig<App>(definition([new FileConfigSource(path, ini)], schema))

    expect(store.current.server).toEqual({ host: 'ini-host', port: 9090 })
  })
})

describe('arrays across sources', () => {
  const arraySchema = z.object({
    tags: z.array(z.string()),
    items: z.array(z.object({ id: z.number() })).default([]),
  })

  type Arrays = z.infer<typeof arraySchema>

  it('holds arrays as frozen arrays, read-only in the type as well', async () => {
    const store = await loadConfig<Arrays>(
      definition([new InlineConfigSource({ tags: ['a', 'b'], items: [{ id: 1 }] })], arraySchema),
    )

    expect(store.current.tags).toEqual(['a', 'b'])
    expect(store.current.items).toEqual([{ id: 1 }])
    expect(Object.isFrozen(store.live.tags)).toBe(true)
    expect(store.live.tags).toBe(store.current.tags)

    const tags: readonly string[] = store.live.tags
    expect(tags[0]).toBe('a')
  })

  // A later source that names a list owns it whole, so a list can be shortened, and the old tail never survives.
  it('replaces a whole array from a later source rather than patching one element', async () => {
    const file = await write('arrays.json', JSON.stringify({ tags: ['a', 'b'], items: [] }))

    const store = await loadConfig<Arrays>(
      definition(
        [new JSONConfigSource(file), new EnvConfigSource({ prefix: 'APP_', env: { APP_TAGS__0: 'override' } })],
        arraySchema,
      ),
    )

    expect(store.current.tags).toEqual(['override'])
    expect(store.explain('tags.0').layers.map(l => l.origin)).toEqual([
      'env:APP_TAGS__0',
      expect.stringMatching(/^file:/),
    ])
    expect(store.explain('tags.1').layers.map(l => l.origin)).toEqual([expect.stringMatching(/^file:/)])
    expect(store.explain('tags.1').value).toBeUndefined()
  })
})

// The codecs end to end: a list or an object written as one value, which indexed keys handle badly or not at all.
describe('a list set as text', () => {
  const listSchema = $t.Object({ tags: $t.List($t.String()) })

  it('reaches the snapshot as a list, over an earlier source', async () => {
    const store = await loadConfig<{ tags: string[] }>(
      definition(
        [new InlineConfigSource({ tags: ['from', 'code'] }), new EnvConfigSource({ env: { TAGS: 'a,b,c' } })],
        listSchema,
      ),
    )

    expect(store.current.tags).toEqual(['a', 'b', 'c'])
    expect(Object.isFrozen(store.current.tags)).toBe(true)
  })

  it('shortens a list, and clears one', async () => {
    const shortened = await loadConfig<{ tags: string[] }>(
      definition(
        [new InlineConfigSource({ tags: ['a', 'b', 'c'] }), new EnvConfigSource({ env: { TAGS: 'only' } })],
        listSchema,
      ),
    )
    const cleared = await loadConfig<{ tags: string[] }>(
      definition(
        [new InlineConfigSource({ tags: ['a', 'b'] }), new EnvConfigSource({ env: { TAGS: '' } })],
        listSchema,
      ),
    )

    expect(shortened.current.tags).toEqual(['only'])
    expect(cleared.current.tags).toEqual([])
  })

  it('gives the same answer from the command line as from the environment', async () => {
    const store = await loadConfig<{ tags: string[] }>(
      definition([new ArgsConfigSource({ argv: ['--tags=a,b,c'] })], listSchema),
    )

    expect(store.current.tags).toEqual(['a', 'b', 'c'])
  })

  it('carries a JSON object through one variable', async () => {
    const jsonSchema = $t.Object({ db: $t.JSON($t.Object({ host: $t.String(), port: $t.Number() })) })

    const store = await loadConfig<{ db: { host: string; port: number } }>(
      definition([new EnvConfigSource({ env: { DB: '{"host":"h","port":5432}' } })], jsonSchema),
    )

    expect(store.current.db).toEqual({ host: 'h', port: 5432 })
  })
})
