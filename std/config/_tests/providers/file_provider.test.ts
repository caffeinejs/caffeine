import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { FileConfigProvider, type ConfigFileParser } from '../../providers/file_provider.js'
import { JSONConfigProvider } from '../../providers/json_provider.js'
import type { ResolutionContext } from '../../types.js'

const ctx: ResolutionContext = { profiles: [] }
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

describe('JSONConfigProvider', () => {
  it('loads a JSON file and flattens nested keys', async () => {
    const path = await writeTmp('test-config.json', JSON.stringify({ db: { host: 'localhost', port: 5432 } }))
    const provider = new JSONConfigProvider(path)
    const [source] = await provider.load(ctx)

    expect(source.entries.get('db.host')?.value).toBe('localhost')
    expect(source.entries.get('db.port')?.value).toBe(5432)
  })

  it('indexes array fields when flattening JSON', async () => {
    const path = await writeTmp('array-config.json', JSON.stringify({ tags: ['a', 'b'], items: [{ id: 1 }] }))
    const provider = new JSONConfigProvider(path)
    const [source] = await provider.load(ctx)

    expect(source.entries.get('tags.0')?.value).toBe('a')
    expect(source.entries.get('tags.1')?.value).toBe('b')
    expect(source.entries.get('items.0.id')?.value).toBe(1)
    expect(source.entries.has('tags')).toBe(false)
  })

  it('sets origin with file: prefix', async () => {
    const path = await writeTmp('origin-test.json', JSON.stringify({ key: 'val' }))
    const provider = new JSONConfigProvider(path)
    const [source] = await provider.load(ctx)

    expect(source.entries.get('key')?.origin).toContain('file:')
  })

  it('reports the file, not just the syntax error, when JSON is malformed', async () => {
    const path = await writeTmp('malformed-config.json', '{ "db": ')
    const provider = new JSONConfigProvider(path)

    await expect(provider.load(ctx)).rejects.toMatchObject({ name: 'ErrConfig', code: 'ERR_CONFIG_FILE_PARSE' })
    await expect(provider.load(ctx)).rejects.toThrow(path)
  })
})

describe('FileConfigProvider', () => {
  // The format seam: any parser at all, no extension registry and no library shipped by std.
  const ini: ConfigFileParser = text =>
    Object.fromEntries(
      text
        .split('\n')
        .filter(line => line !== '')
        .map(line => line.split('=') as [string, string]),
    )

  it('uses the parser it was given, whatever the extension says', async () => {
    const path = await writeTmp('custom-config.ini', 'db.host=localhost\ndb.port=5432')
    const provider = new FileConfigProvider(path, ini)
    const [source] = await provider.load(ctx)

    expect(source.entries.get('db.host')?.value).toBe('localhost')
    expect(source.entries.get('db.port')?.value).toBe('5432')
  })

  it('overrides the builtin JSON parser when handed another one for a .json file', async () => {
    const path = await writeTmp('override-config.json', 'db.host=from-ini')
    const provider = new FileConfigProvider(path, ini)
    const [source] = await provider.load(ctx)

    expect(source.entries.get('db.host')?.value).toBe('from-ini')
  })

  it('wraps a parser that throws, naming the file and keeping the original as cause', async () => {
    const path = await writeTmp('exploding-config.conf', 'anything')
    const boom = new Error('parser exploded')
    const provider = new FileConfigProvider(path, () => {
      throw boom
    })

    await expect(provider.load(ctx)).rejects.toMatchObject({
      name: 'ErrConfig',
      code: 'ERR_CONFIG_FILE_PARSE',
      cause: boom,
    })
    await expect(provider.load(ctx)).rejects.toThrow(path)
  })

  // Without the guard `flattenObject` would index the list into "0"/"1" and merge it as real config.
  it.each([
    ['an array', () => [] as unknown as Record<string, unknown>],
    ['null', () => null as unknown as Record<string, unknown>],
    ['a scalar', () => 'nope' as unknown as Record<string, unknown>],
  ])('rejects a parser that returns %s instead of a mapping', async (_label, parse) => {
    const path = await writeTmp('not-a-mapping.conf', 'whatever')
    const provider = new FileConfigProvider(path, parse)

    await expect(provider.load(ctx)).rejects.toMatchObject({ name: 'ErrConfig', code: 'ERR_CONFIG_FILE_PARSE' })
    await expect(provider.load(ctx)).rejects.toThrow(/must be a mapping/)
  })

  it('accepts an async parser', async () => {
    // A YAML/TOML library the application already depends on may only expose an async parse; the value type
    // must not force it through a synchronous shim.
    const path = await writeTmp('async-config.json', JSON.stringify({ db: { host: 'async-host' } }))
    const provider = new FileConfigProvider(path, async text => JSON.parse(text) as Record<string, unknown>)
    const [source] = await provider.load(ctx)

    expect(source.entries.get('db.host')?.value).toBe('async-host')
  })
})

describe('FileConfigProvider profile files', () => {
  const parse: ConfigFileParser = text => JSON.parse(text) as Record<string, unknown>

  it('layers application-<profile> over the base, profile winning', async () => {
    // A profile file is a deployment-time override of the base, not a sibling merged by registration order —
    // so its value must win even though it is read from the same provider.
    const base = await writeTmp('layered.json', JSON.stringify({ db: { host: 'base', port: 5432 } }))
    await writeTmp('layered-dev.json', JSON.stringify({ db: { host: 'dev' } }))

    const merged = mergeEntries(await new FileConfigProvider(base, parse).load({ profiles: ['dev'] }))

    expect(merged['db.host']).toBe('dev')
    expect(merged['db.port']).toBe(5432)
  })

  it('lets a later active profile win over an earlier one', async () => {
    const base = await writeTmp('order.json', JSON.stringify({ region: 'base' }))
    await writeTmp('order-eu.json', JSON.stringify({ region: 'eu' }))
    await writeTmp('order-canary.json', JSON.stringify({ region: 'canary' }))

    const merged = mergeEntries(await new FileConfigProvider(base, parse).load({ profiles: ['eu', 'canary'] }))

    expect(merged['region']).toBe('canary')
  })

  it('marks a profile file entry with the profile it came from', async () => {
    const base = await writeTmp('tagged.json', JSON.stringify({ a: 1 }))
    await writeTmp('tagged-prod.json', JSON.stringify({ b: 2 }))

    const sources = await new FileConfigProvider(base, parse).load({ profiles: ['prod'] })
    const overlay = sources.find(s => s.name.endsWith('tagged-prod.json'))!

    expect(overlay.entries.get('b')?.profile).toBe('prod')
  })

  it('skips a profile file that does not exist', async () => {
    const base = await writeTmp('lonely.json', JSON.stringify({ a: 1 }))

    const sources = await new FileConfigProvider(base, parse).load({ profiles: ['dev', 'prod'] })

    expect(sources).toHaveLength(1)
    expect(sources[0].name).toBe(`file:${base}`)
  })

  it('skips a missing base file by default', async () => {
    // Matches a Spring `application.yml` that is simply not on the path: absent means "does not apply".
    const provider = new JSONConfigProvider(join(tmpdir(), 'does-not-exist-xyz.json'))

    await expect(provider.load(ctx)).resolves.toEqual([])
  })

  it('throws for a missing base file when optional is false', async () => {
    const provider = new JSONConfigProvider(join(tmpdir(), 'does-not-exist-required.json'), { optional: false })

    await expect(provider.load(ctx)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

/** Flattened key → value across every returned source, first-wins — the same rule the engine merge applies. */
function mergeEntries(sources: Awaited<ReturnType<FileConfigProvider['load']>>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const source of sources) {
    for (const [key, entry] of source.entries) {
      if (!(key in out)) {
        out[key] = entry.value
      }
    }
  }
  return out
}
