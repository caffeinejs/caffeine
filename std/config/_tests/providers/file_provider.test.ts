import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { FileConfigProvider, type ConfigFileParser } from '../../providers/file_provider.js'
import { JSONConfigProvider } from '../../providers/json_provider.js'
import type { ResolutionContext } from '../../types.js'

const ctx: ResolutionContext = { app: 'test', profiles: ['default'] }
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

  it('loads a sibling JSON file for an active profile', async () => {
    const path = await writeTmp('json-profile.json', JSON.stringify({ db: { host: 'base', port: 1 } }))
    await writeTmp('json-profile-prod.json', JSON.stringify({ db: { host: 'prod' } }))
    const provider = new JSONConfigProvider(path)
    const sources = await provider.load({ app: 'test', profiles: ['prod'] })

    // JSONConfigProvider is FileConfigProvider with JSON.parse; the subclass must pick up siblings too.
    expect(sources[0].entries.get('db.host')?.value).toBe('prod')
    expect(sources[1].entries.get('db.port')?.value).toBe(1)
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

  it('overrides overlapping keys from a profile file and keeps keys that only the base file has', async () => {
    const path = await writeTmp('profile-override.ini', 'db.host=base\ndb.port=5432')
    await writeTmp('profile-override-prod.ini', 'db.host=prod')
    const provider = new FileConfigProvider(path, ini)
    const sources = await provider.load({ app: 'test', profiles: ['prod'] })

    // A later source does not wipe the tree: prod replaces host, port still comes from the constructor path.
    expect(sources[0].entries.get('db.host')?.value).toBe('prod')
    expect(sources[1].entries.get('db.port')?.value).toBe('5432')
    expect(sources[1].entries.get('db.host')?.value).toBe('base')
  })

  it('returns later profiles before earlier ones, and the constructor path last', async () => {
    const path = await writeTmp('profile-order.ini', 'db.host=base')
    const dev = await writeTmp('profile-order-dev.ini', 'db.host=dev')
    const prod = await writeTmp('profile-order-prod.ini', 'db.host=prod')
    const provider = new FileConfigProvider(path, ini)
    const sources = await provider.load({ app: 'test', profiles: ['dev', 'prod'] })

    // mergeSources is first-wins; this order is the contract, not an accident of Map insertion.
    expect(sources.map(s => s.name)).toEqual([`file:${prod}`, `file:${dev}`, `file:${path}`])
    expect(sources[0].entries.get('db.host')?.value).toBe('prod')
    expect(sources[1].entries.get('db.host')?.value).toBe('dev')
    expect(sources[2].entries.get('db.host')?.value).toBe('base')
  })

  it('skips a missing profile file rather than failing the load', async () => {
    const path = await writeTmp('profile-missing.ini', 'db.host=base')
    const provider = new FileConfigProvider(path, ini)
    const sources = await provider.load({ app: 'test', profiles: ['prod'] })

    expect(sources).toHaveLength(1)
    expect(sources[0].entries.get('db.host')?.value).toBe('base')
  })

  it('does not read a sibling file whose profile is not active', async () => {
    const path = await writeTmp('profile-inactive.ini', 'db.host=base')
    await writeTmp('profile-inactive-dev.ini', 'db.host=dev')
    await writeTmp('profile-inactive-prod.ini', 'db.host=prod')
    const provider = new FileConfigProvider(path, ini)
    const sources = await provider.load({ app: 'test', profiles: ['prod'] })

    expect(sources.map(s => s.entries.get('db.host')?.value)).toEqual(['prod', 'base'])
  })

  it('names the profile file, not the constructor path, when that sibling is malformed', async () => {
    const path = await writeTmp('profile-malformed.ini', 'db.host=base')
    const prod = await writeTmp('profile-malformed-prod.ini', 'anything')
    const provider = new FileConfigProvider(path, () => {
      throw new Error('parser exploded')
    })

    await expect(provider.load({ app: 'test', profiles: ['prod'] })).rejects.toMatchObject({
      name: 'ErrConfig',
      code: 'ERR_CONFIG_FILE_PARSE',
    })
    await expect(provider.load({ app: 'test', profiles: ['prod'] })).rejects.toThrow(prod)
  })

  it('stamps origin and profile from the sibling that contributed the entry', async () => {
    const path = await writeTmp('profile-origin.ini', 'db.host=base')
    const prod = await writeTmp('profile-origin-prod.ini', 'db.host=prod')
    const provider = new FileConfigProvider(path, ini)
    const [profileSource, baseSource] = await provider.load({ app: 'test', profiles: ['prod'] })

    expect(profileSource.entries.get('db.host')?.origin).toBe(`file:${prod}`)
    expect(profileSource.entries.get('db.host')?.profile).toBe('prod')
    expect(baseSource.entries.get('db.host')?.origin).toBe(`file:${path}`)
    expect(baseSource.entries.get('db.host')?.profile).toBeUndefined()
  })

  it.each(['../secret', 'foo/bar', 'foo\\bar', '..'])('refuses a path-like profile name %j', async profile => {
    const path = await writeTmp('profile-path.ini', 'db.host=base')
    const provider = new FileConfigProvider(path, ini)

    await expect(provider.load({ app: 'test', profiles: [profile] })).rejects.toMatchObject({
      name: 'ErrConfig',
      code: 'ERR_CONFIG_PROFILE',
    })
  })
})
