import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mergeLayers, expandKeys } from '../../merge.js'
import { FileConfigSource, concernsFile, type ConfigFileParser } from '../../sources/file_source.js'
import { JSONConfigSource } from '../../sources/json_source.js'
import type { ConfigLayer, ConfigLoadContext } from '../../types.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'caffeine-config-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function write(name: string, content: unknown): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8')
  return path
}

function context(profiles: string[] = []): ConfigLoadContext {
  return { profiles, signal: new AbortController().signal, logger: undefined as never }
}

function merged(layers: readonly ConfigLayer[]): Record<string, unknown> {
  return mergeLayers(layers) as Record<string, unknown>
}

describe('JSONConfigSource', () => {
  it('loads a JSON file as a tree, arrays included', async () => {
    const path = await write('app.json', { db: { host: 'localhost', port: 5432 }, tags: ['a', 'b'] })

    const [layer] = await new JSONConfigSource(path).load(context())

    expect(layer.name).toBe(`file:${path}`)
    expect(layer.data).toEqual({ db: { host: 'localhost', port: 5432 }, tags: ['a', 'b'] })
  })

  it('is named after its file unless told otherwise', () => {
    expect(new JSONConfigSource('./config/app.json').name).toBe('file:./config/app.json')
    expect(new JSONConfigSource('./config/app.json', { name: 'app' }).name).toBe('app')
  })

  it('takes a dotted key literally', async () => {
    const path = await write('dotted.json', { 'db.host': 'x' })

    const [layer] = await new JSONConfigSource(path).load(context())

    expect(layer.data).toEqual({ 'db.host': 'x' })
  })

  it('names the file, not just the syntax error, when the JSON is malformed', async () => {
    const path = await write('malformed.json', '{ "db": ')
    const source = new JSONConfigSource(path)

    await expect(source.load(context())).rejects.toMatchObject({ name: 'ErrConfig', code: 'ERR_CONFIG_FILE_PARSE' })
    await expect(source.load(context())).rejects.toThrow(path)
  })

  it('skips a missing base file by default', async () => {
    await expect(new JSONConfigSource(join(dir, 'absent.json')).load(context())).resolves.toEqual([])
  })

  it('fails for a missing base file when it is not optional', async () => {
    await expect(
      new JSONConfigSource(join(dir, 'absent.json'), { optional: false }).load(context()),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  // Absence and failure are different things: an optional file that is there but broken still fails.
  it('fails for a broken file even when the file is optional', async () => {
    const path = await write('broken.json', 'not json')

    await expect(new JSONConfigSource(path, { optional: true }).load(context())).rejects.toMatchObject({
      code: 'ERR_CONFIG_FILE_PARSE',
    })
  })

  it('does not ask the store to tolerate its failures', () => {
    expect(new JSONConfigSource('./app.json', { optional: true })).not.toHaveProperty('optional')
  })
})

describe('FileConfigSource', () => {
  const ini: ConfigFileParser = text =>
    Object.fromEntries(
      text
        .split('\n')
        .filter(line => line !== '')
        .map(line => line.split('=') as [string, string]),
    )

  it('uses the parser it was given, whatever the extension says', async () => {
    const path = await write('custom.json', 'db.host=localhost\ndb.port=5432')

    const [layer] = await new FileConfigSource(path, ini).load(context())

    expect(layer.data).toEqual({ 'db.host': 'localhost', 'db.port': '5432' })
  })

  // A format with no nesting of its own describes a tree through dotted keys, when the parser asks for it.
  it('expands dotted keys when the parser does', async () => {
    const path = await write('app.ini', 'db.host=localhost\ndb.port=5432')

    const [layer] = await new FileConfigSource(path, text => expandKeys(ini(text) as never)).load(context())

    expect(layer.data).toEqual({ db: { host: 'localhost', port: '5432' } })
  })

  it('wraps a parser that throws, naming the file and keeping the original as cause', async () => {
    const path = await write('exploding.conf', 'anything')
    const boom = new Error('parser exploded')
    const source = new FileConfigSource(path, () => {
      throw boom
    })

    await expect(source.load(context())).rejects.toMatchObject({ code: 'ERR_CONFIG_FILE_PARSE', cause: boom })
    await expect(source.load(context())).rejects.toThrow(path)
  })

  it.each([
    ['an array', () => [] as unknown as Record<string, unknown>],
    ['null', () => null as unknown as Record<string, unknown>],
    ['a scalar', () => 'nope' as unknown as Record<string, unknown>],
  ])('refuses a parser that returns %s instead of a mapping', async (_label, parse) => {
    const path = await write('not-a-mapping.conf', 'whatever')

    await expect(new FileConfigSource(path, parse).load(context())).rejects.toThrow(/must be a mapping/)
  })

  it('accepts an async parser', async () => {
    const path = await write('async.json', { db: { host: 'async-host' } })

    const [layer] = await new FileConfigSource(path, async text => JSON.parse(text) as Record<string, unknown>).load(
      context(),
    )

    expect(layer.data).toEqual({ db: { host: 'async-host' } })
  })
})

describe('FileConfigSource profile files', () => {
  it('layers <name>-<profile> over the base, base first, so the profile wins', async () => {
    const base = await write('layered.json', { db: { host: 'base', port: 5432 } })
    await write('layered-dev.json', { db: { host: 'dev' } })

    const layers = await new JSONConfigSource(base).load(context(['dev']))

    expect(layers.map(l => [l.name.replace(dir, ''), l.profile])).toEqual([
      ['file:/layered.json', undefined],
      ['file:/layered-dev.json', 'dev'],
    ])
    expect(merged(layers)).toEqual({ db: { host: 'dev', port: 5432 } })
  })

  it('lets a later active profile win over an earlier one', async () => {
    const base = await write('order.json', { region: 'base' })
    await write('order-eu.json', { region: 'eu' })
    await write('order-canary.json', { region: 'canary' })

    expect(merged(await new JSONConfigSource(base).load(context(['eu', 'canary'])))).toEqual({ region: 'canary' })
  })

  it('skips a profile file that does not exist', async () => {
    const base = await write('lonely.json', { a: 1 })

    const layers = await new JSONConfigSource(base).load(context(['dev', 'prod']))

    expect(layers).toHaveLength(1)
  })

  // Nothing named a profile up front, so the base file decides which siblings layer over it.
  it('selects its own overlays from the caffeine.profiles its base declares', async () => {
    const base = await write('self.json', { caffeine: { profiles: ['eu'] }, region: 'base' })
    await write('self-eu.json', { region: 'eu' })

    expect(merged(await new JSONConfigSource(base).load(context())).region).toBe('eu')
  })

  it('accepts delimited text for its own caffeine.profiles', async () => {
    const base = await write('self-text.json', { caffeine: { profiles: 'eu,canary' }, region: 'base' })
    await write('self-text-eu.json', { region: 'eu' })
    await write('self-text-canary.json', { region: 'canary' })

    expect(merged(await new JSONConfigSource(base).load(context())).region).toBe('canary')
  })

  it('lets the profiles named up front override the ones its base declares', async () => {
    const base = await write('beaten.json', { caffeine: { profiles: ['dev'] }, region: 'base' })
    await write('beaten-dev.json', { region: 'dev' })
    await write('beaten-eu.json', { region: 'eu' })

    expect(merged(await new JSONConfigSource(base).load(context(['eu']))).region).toBe('eu')
  })

  it('selects no overlay when its base declares no profile', async () => {
    const base = await write('none.json', { region: 'base' })
    await write('none-eu.json', { region: 'eu' })

    expect(await new JSONConfigSource(base).load(context())).toHaveLength(1)
  })
})

describe('FileConfigSource watching', () => {
  it('has no watcher unless asked for one', () => {
    expect(new JSONConfigSource('./app.json').watch).toBeUndefined()
  })

  it('calls back when the file or a profile sibling changes, and stops when told', async () => {
    const base = await write('watched.json', { a: 1 })
    const changed = vi.fn()

    const stop = new JSONConfigSource(base, { watch: true }).watch!(changed)
    try {
      await write('watched.json', { a: 2 })
      await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 2_000 })

      changed.mockClear()
      await write('watched-eu.json', { a: 3 })
      await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 2_000 })
    } finally {
      stop()
    }
  })

  // Decided by name, so the directory's other files cost a reload nothing.
  it('reacts to the file, a profile sibling, the ..data link and an unnamed change, and to nothing else', () => {
    const path = '/etc/app/config.json'

    expect(concernsFile(path, 'config.json')).toBe(true)
    expect(concernsFile(path, 'config-eu.json')).toBe(true)
    expect(concernsFile(path, '..data')).toBe(true)
    expect(concernsFile(path, null)).toBe(true)
    expect(concernsFile(path, 'unrelated.txt')).toBe(false)
    expect(concernsFile(path, 'config.yaml')).toBe(false)
    expect(concernsFile(path, 'other-eu.json')).toBe(false)
  })
})
