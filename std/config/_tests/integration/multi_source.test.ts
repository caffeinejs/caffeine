import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { $t } from '../../../schema/t.js'
import { bootstrapConfig } from '../../bootstrap.js'
import type { ConfigProvider, ResolutionContext } from '../../config.js'
import { ArgsConfigProvider } from '../../providers/args_provider.js'
import { EnvConfigProvider } from '../../providers/env_provider.js'
import { FileConfigProvider } from '../../providers/file_provider.js'
import { InlineConfigProvider } from '../../providers/inline_provider.js'
import { JSONConfigProvider } from '../../providers/json_provider.js'
import { ConfigPriority, ConfigSources } from '../../sources.js'

// `server` is present in every scenario below. `db` and `app` may be absent from all sources, so they carry an
// explicit object default — this is what the "missing everywhere" case (schema default, no source origin) tests.
const schema = z.object({
  server: z.object({ port: z.coerce.number(), host: z.string() }),
  db: z.object({ url: z.string() }).default({ url: '' }),
  app: z.object({ name: z.string() }).default({ name: 'default-app' }),
})

const tmp: string[] = []

async function writeTmp(name: string, content: string): Promise<string> {
  const path = join(tmpdir(), name)
  await writeFile(path, content, 'utf8')
  tmp.push(path)
  return path
}

afterEach(async () => {
  for (const f of tmp.splice(0)) {
    await unlink(f).catch(() => undefined)
  }
})

describe('config multi-source precedence & provenance', () => {
  // server.host: in env + file + inline. server.port: in file + inline. db.url: inline only. app.name: nowhere.
  async function providers(): Promise<{ env: ConfigProvider; file: ConfigProvider; inline: ConfigProvider }> {
    const filePath = await writeTmp('multi-source.json', JSON.stringify({ server: { port: 8080, host: 'file-host' } }))
    return {
      env: new EnvConfigProvider({ prefix: 'APP_', env: ENV }),
      file: new JSONConfigProvider(filePath),
      inline: new InlineConfigProvider({ server: { port: 3000, host: 'inline-host' }, db: { url: 'inline-url' } }),
    }
  }

  const ENV = { APP_SERVER__HOST: 'env-host' }

  it('resolves each key from its highest-precedence source (env > file > inline)', async () => {
    const p = await providers()
    const ctx: ResolutionContext = { profiles: ['default'] }

    const { config, diagnostics } = await bootstrapConfig({
      sources: ConfigSources.of(p.env, p.file, p.inline),
      schema,
      profiles: ctx.profiles,
    })

    // present in all three -> env wins
    expect(config.server.host).toBe('env-host')
    expect(diagnostics.originOf('server.host')).toMatch(/^env:/)

    // present in file + inline -> file wins
    expect(config.server.port).toBe(8080)
    expect(diagnostics.originOf('server.port')).toMatch(/^file:/)

    // inline only
    expect(config.db.url).toBe('inline-url')
    expect(diagnostics.originOf('db.url')).toMatch(/^inline/)

    // missing everywhere -> schema default, no origin
    expect(config.app.name).toBe('default-app')
    expect(diagnostics.originOf('app.name')).toBeUndefined()
  })

  it('reordering providers changes the winning source (first wins)', async () => {
    const p = await providers()
    const ctx: ResolutionContext = { profiles: ['default'] }

    const { config, diagnostics } = await bootstrapConfig({
      sources: ConfigSources.of(p.inline, p.file, p.env),
      schema,
      profiles: ctx.profiles,
    })

    expect(config.server.host).toBe('inline-host')
    expect(diagnostics.originOf('server.host')).toMatch(/^inline/)
    expect(config.server.port).toBe(3000)
    expect(diagnostics.originOf('server.port')).toMatch(/^inline/)
  })

  // std parses JSON and nothing else; every other format is a parse function the application already has.
  it('loads a source in a format std does not know, from a parser the caller supplies', async () => {
    const iniPath = await writeTmp('multi-source.ini', 'server.host=ini-host\nserver.port=9090\n')
    const ctx: ResolutionContext = { profiles: ['default'] }
    const ini = (text: string): Record<string, unknown> =>
      Object.fromEntries(
        text
          .split('\n')
          .filter(line => line !== '')
          .map(line => line.split('=') as [string, string]),
      )

    const { config, diagnostics } = await bootstrapConfig({
      sources: ConfigSources.of(new FileConfigProvider(iniPath, ini)),
      schema,
      profiles: ctx.profiles,
    })

    expect(config.server.host).toBe('ini-host')
    expect(config.server.port).toBe(9090)
    expect(diagnostics.originOf('server.host')).toMatch(/^file:/)
  })
})

describe('config array flatten + typed handle', () => {
  const arraySchema = z.object({
    tags: z.array(z.string()),
    items: z.array(z.object({ id: z.number() })).default([]),
  })

  it('materializes arrays as Array fields and preserves ConfigHandle typing', async () => {
    const { config, validated } = await bootstrapConfig({
      sources: ConfigSources.of(new InlineConfigProvider({ tags: ['a', 'b'], items: [{ id: 1 }] })),
      schema: arraySchema,
    })

    expect(Array.isArray(validated.tags)).toBe(true)
    expect(validated.tags).toEqual(['a', 'b'])
    expect(Array.isArray(validated.items)).toBe(true)
    expect(validated.items).toEqual([{ id: 1 }])

    // Live handle: an array field is the frozen array itself, handed back as-is rather than copied per read.
    expect(Array.isArray(config.tags)).toBe(true)
    expect([...config.tags]).toEqual(['a', 'b'])
    expect(Object.isFrozen(config.tags)).toBe(true)
    expect(config.tags).toBe(config.tags)

    // Compile-time: ConfigHandle maps array fields to ReadonlyArray.
    const tags: ReadonlyArray<string> = config.tags
    expect(tags[0]).toBe('a')
  })

  it('replaces a whole array from the higher-priority source rather than patching an element', async () => {
    const filePath = await writeTmp('array-override.json', JSON.stringify({ tags: ['a', 'b'], items: [] }))
    const ctx: ResolutionContext = { profiles: ['default'] }

    const { config, diagnostics } = await bootstrapConfig({
      sources: ConfigSources.of(
        new EnvConfigProvider({ prefix: 'APP_', env: { APP_TAGS__0: 'override' } }),
        new JSONConfigProvider(filePath),
      ),
      schema: arraySchema,
      profiles: ctx.profiles,
    })

    // An array is replaced, never complemented: the first source that mentions the path owns the whole list.
    // Merging element by element instead would make it impossible to *shorten* a list from a higher-priority
    // source — the old tail would always survive whatever was meant to override it.
    expect(Array.isArray(config.tags)).toBe(true)
    expect([...config.tags]).toEqual(['override'])
    expect(diagnostics.originOf('tags.0')).toMatch(/^env:/)
    expect(diagnostics.originOf('tags.1')).toBeUndefined()
  })
})

/**
 * The whole point of the codecs, end to end: a real provider, a real merge, a real validation.
 *
 * The indexed spelling above still works and is untouched. This is the alternative for the cases it handles
 * badly — shortening a list, clearing one, or writing one without counting.
 */
describe('a list set as text', () => {
  const listSchema = $t.Object({ tags: $t.List($t.String()) })

  const envSource = (env: Record<string, string>): EnvConfigProvider => new EnvConfigProvider({ env })

  const ctx: ResolutionContext = { profiles: ['default'] }

  it('reaches the validated tree as a list, over a lower band', async () => {
    const { validated, config } = await bootstrapConfig({
      sources: new ConfigSources()
        .add(new InlineConfigProvider({ tags: ['from', 'code'] }), ConfigPriority.CODE)
        .add(envSource({ TAGS: 'a,b,c' }), ConfigPriority.ENV),
      schema: listSchema,
      profiles: ctx.profiles,
    })

    expect(validated.tags).toEqual(['a', 'b', 'c'])
    // And it arrives read-only through the handle, like any other array field.
    expect(Object.isFrozen(config.tags)).toBe(true)
  })

  it('shortens a list, which indexed keys cannot do', async () => {
    const { validated } = await bootstrapConfig({
      sources: new ConfigSources()
        .add(new InlineConfigProvider({ tags: ['a', 'b', 'c'] }), ConfigPriority.CODE)
        .add(envSource({ TAGS: 'only' }), ConfigPriority.ENV),
      schema: listSchema,
      profiles: ctx.profiles,
    })

    expect(validated.tags).toEqual(['only'])
  })

  it('clears a list, which nothing could express before', async () => {
    const { validated } = await bootstrapConfig({
      sources: new ConfigSources()
        .add(new InlineConfigProvider({ tags: ['a', 'b'] }), ConfigPriority.CODE)
        .add(envSource({ TAGS: '' }), ConfigPriority.ENV),
      schema: listSchema,
      profiles: ctx.profiles,
    })

    expect(validated.tags).toEqual([])
  })

  it('gives the same answer from the command line as from the environment', async () => {
    // `_coerce` exists so a setting moving between the two cannot change type; the codec must not break that.
    const { validated } = await bootstrapConfig({
      sources: ConfigSources.of(new ArgsConfigProvider({ argv: ['--tags=a,b,c'] })),
      schema: listSchema,
      profiles: ctx.profiles,
    })

    expect(validated.tags).toEqual(['a', 'b', 'c'])
  })

  it('carries a JSON object through one variable', async () => {
    const jsonSchema = $t.Object({ db: $t.JSON($t.Object({ host: $t.String(), port: $t.Number() })) })

    const { validated } = await bootstrapConfig({
      sources: ConfigSources.of(envSource({ DB: '{"host":"h","port":5432}' })),
      schema: jsonSchema,
      profiles: ctx.profiles,
    })

    expect(validated.db).toEqual({ host: 'h', port: 5432 })
  })
})
