import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { loadConfig } from '../../load.js'
import { mergeLayers, expandKeys } from '../../merge.js'
import { passthroughConfigSchema } from '../../schema.js'
import type { ConfigLayer, ConfigLoadContext } from '../../types.js'
import { JSONConfigSource } from '../json/index.js'
import { FileConfigSource, concernsFile, type ConfigFileParser } from './file.js'

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

  // The profiles are chosen before any source loads. The base file's own `caffeine.profiles` is an ordinary key: the
  // overlay it would pick is one no other source, and no bean, would follow.
  it('selects no overlay from the caffeine.profiles its base declares', async () => {
    const base = await write('self.json', { caffeine: { profiles: ['eu'] }, region: 'base' })
    await write('self-eu.json', { region: 'eu' })

    expect(await new JSONConfigSource(base).load(context())).toHaveLength(1)
  })

  // `app/config-x/../../outside.json` is `outside.json`, a directory above the one configured. A profile named up front
  // is refused before any path is built from it, and one the base file declares is never read.
  it('never reads a file outside its directory through a profile', async () => {
    await mkdir(join(dir, 'app'))
    await write('outside.json', { secret: 'outside' })

    const declared = await write('app/config.json', { caffeine: { profiles: ['x/../../outside'] } })
    expect(await new JSONConfigSource(declared).load(context())).toHaveLength(1)

    const named = await write('app/named.json', { region: 'base' })
    const definition = {
      schema: passthroughConfigSchema,
      key: undefined,
      storeKey: undefined,
      sources: [new JSONConfigSource(named)],
      loadTimeoutMs: 30_000,
    }
    await expect(loadConfig(definition, { profiles: ['x/../../outside'] })).rejects.toThrow(
      expect.objectContaining({ code: 'ERR_CONFIG_PROFILE' }),
    )
  })
})

describe('FileConfigSource interpolation', () => {
  it('marks every layer for interpolation unless told not to', async () => {
    const base = await write('marked.json', { a: 'x' })
    await write('marked-dev.json', { a: 'y' })

    const on = await new JSONConfigSource(base).load(context(['dev']))
    const off = await new JSONConfigSource(base, { interpolate: false }).load(context(['dev']))

    expect(on.map(layer => layer.interpolate)).toEqual([true, true])
    expect(off.map(layer => layer.interpolate)).toEqual([false, false])
  })

  it('reads a file as written when told not to interpolate, malformed placeholders included', async () => {
    const path = await write('literal.json', { a: '${not a placeholder', b: '${evn:X}' })

    const [layer] = await new JSONConfigSource(path, { interpolate: false }).load(context())

    expect(layer.data).toEqual({ a: '${not a placeholder', b: '${evn:X}' })
  })

  it('takes a key holding ${ literally', async () => {
    const path = await write('keys.json', { '${key}': 'v' })

    const [layer] = await new JSONConfigSource(path).load(context())

    expect(layer.data).toEqual({ '${key}': 'v' })
  })

  // Checked as each file is read, overridden or not: the load that brought the mistake fails, and names the file.
  it.each([
    ['the base file', { db: { url: 'x${evn:HOST}' } }, {}, 'base', '"db.url"', 'character 2'],
    ['a profile file', { db: { url: 'fine' } }, { db: { url: '${env:HOST' } }, 'profile', '"db.url"', 'character 1'],
    ['a list', { hosts: ['ok', '${env:}'] }, {}, 'base', '"hosts.1"', 'character 1'],
    ['a value a profile file overrides', { a: '${field:x}' }, { a: 'fine' }, 'base', '"a"', 'character 1'],
  ])('refuses a malformed placeholder in %s', async (_label, base, dev, culprit, path, at) => {
    const basePath = await write('syntax.json', base)
    const devPath = await write('syntax-dev.json', dev)
    const file = culprit === 'base' ? basePath : devPath

    const error = await new JSONConfigSource(basePath).load(context(['dev'])).catch((thrown: unknown) => thrown)

    expect(error).toMatchObject({ name: 'ErrConfig', code: 'ERR_CONFIG_INTERPOLATION' })
    expect((error as Error).message).toContain(
      `Cannot interpolate ${path} in config file "${file}": the placeholder at ${at}`,
    )
  })
})

describe('FileConfigSource watching', () => {
  it('has no watcher unless asked for one', () => {
    expect(new JSONConfigSource('./app.json').watch).toBeUndefined()
  })

  // `fs.watch` returns before the platform's watcher is live, and a change made in that gap is never reported —
  // not late, never. So a change is made again until one is seen, rather than once and then waited for.
  async function changeUntilSeen(changed: Mock, name: string): Promise<void> {
    let revision = 0

    await vi.waitFor(
      async () => {
        await write(name, { revision: ++revision })
        expect(changed).toHaveBeenCalled()
      },
      { timeout: 10_000, interval: 25 },
    )
  }

  // Reports of the changes already made may still be on their way. Until none has arrived for a while, a call
  // cannot be credited to the change that follows.
  async function quiet(changed: Mock): Promise<void> {
    await vi.waitFor(
      async () => {
        changed.mockClear()
        await sleep(200)
        expect(changed).not.toHaveBeenCalled()
      },
      { timeout: 5_000, interval: 0 },
    )
  }

  it('calls back when the file or a profile sibling changes, and stops when told', async () => {
    const base = await write('watched.json', { a: 1 })
    const changed = vi.fn()

    const stop = new JSONConfigSource(base, { watch: true }).watch!(changed)
    try {
      await changeUntilSeen(changed, 'watched.json')

      await quiet(changed)
      await changeUntilSeen(changed, 'watched-eu.json')
    } finally {
      stop()
    }

    await quiet(changed)
    await write('watched.json', { a: 2 })
    await write('watched-eu.json', { a: 3 })
    await sleep(200)

    expect(changed).not.toHaveBeenCalled()
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
