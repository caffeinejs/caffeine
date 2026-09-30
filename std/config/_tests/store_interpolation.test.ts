import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $t } from '../../schema/t.js'
import { ErrConfigValidation } from '../errors.js'
import { loadConfig } from '../load.js'
import { RecordingLogger } from '../log.testkit.js'
import { passthroughConfigSchema } from '../schema.js'
import { EnvConfigSource } from '../sources/env/index.js'
import { InlineConfigSource } from '../sources/inline/index.js'
import { JSONConfigSource } from '../sources/json/index.js'
import { kMergedTree } from '../store.js'
import { readPath } from '../tree.js'
import type { ConfigDefinition, ConfigLayer, ConfigSchema, ConfigSource } from '../types.js'

// Never set anywhere: a variable a test needs to be missing.
const UNSET = 'CAFFEINE_INTERPOLATION_TEST_UNSET'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'caffeine-config-'))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

async function write(name: string, content: unknown): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, JSON.stringify(content), 'utf8')
  return path
}

function definition<T = Record<string, unknown>>(
  sources: ConfigSource[],
  schema: ConfigSchema<T> = passthroughConfigSchema as ConfigSchema<T>,
): ConfigDefinition<T> {
  return { schema, key: undefined, storeKey: undefined, sources, loadTimeoutMs: 30_000 }
}

/** A live source over data the test changes. */
function liveSource(name: string, initial: Record<string, unknown>) {
  const state = { data: initial }
  const source: ConfigSource = {
    name,
    live: true,
    load: () => [{ name, data: structuredClone(state.data) as never }],
  }
  return { source, state }
}

async function fileSource(content: unknown, options?: { interpolate?: boolean; watch?: boolean }) {
  return new JSONConfigSource(await write('app.json', content), options)
}

describe('ConfigStore interpolation', () => {
  it('fills in a file from the environment and from the file itself', async () => {
    vi.stubEnv('NAME', 'test')
    const content = {
      app: { name: '${env:NAME:-No Name} and ${config:test.nickname}', title: `\${env:${UNSET}:-No Name}` },
      test: { nickname: 'HELLO' },
    }

    const store = await loadConfig(definition([await fileSource(content)]))

    expect(store.current).toMatchObject({ app: { name: 'test and HELLO', title: 'No Name' } })
  })

  // A placeholder always brings in text. The schema converts it, exactly as it converts the environment's text.
  it('hands the schema text it converts like any environment value', async () => {
    vi.stubEnv('PORT', '8080')
    const schema = $t.Object({ server: $t.Object({ port: $t.Number() }) })

    const store = await loadConfig<{ server: { port: number } }>(
      definition([await fileSource({ server: { port: '${env:PORT}' } })], schema),
    )

    expect(store.current.server.port).toBe(8080)
  })

  it('reads a value from a source registered before the file', async () => {
    const inline = new InlineConfigSource({ team: { nickname: 'HELLO' } })

    const store = await loadConfig(definition([inline, await fileSource({ app: { name: '${config:team.nickname}' } })]))

    expect(store.current).toMatchObject({ app: { name: 'HELLO' } })
  })

  // The environment overrides the host the file named, and the URL built from that host follows it.
  it('reads a value from a source registered after the file', async () => {
    const file = await fileSource({ db: { host: 'localhost', url: 'postgres://${config:db.host}/app' } })
    const env = new EnvConfigSource({ prefix: 'APP_', env: { APP_DB__HOST: 'prod-db' } })

    const store = await loadConfig(definition([file, env]))

    expect(store.current).toMatchObject({ db: { host: 'prod-db', url: 'postgres://prod-db/app' } })
  })

  // The environment source's values are data: one that looks like a placeholder is never read as one.
  it('never interpolates what a source that does not interpolate supplies', async () => {
    vi.stubEnv('SECRET', 'super-s3cret')
    const env = new EnvConfigSource({ prefix: 'APP_', env: { APP_A: '${env:SECRET}' } })

    const store = await loadConfig(definition([env]))

    expect(store.current).toEqual({ a: '${env:SECRET}' })
  })

  it('fails the first load with every value it cannot fill in, never quoting one', async () => {
    vi.stubEnv('TOKEN', 'super-s3cret')
    const content = { db: { password: `\${env:${UNSET}}`, url: 'https://${env:TOKEN}@${config:db.missing}' } }

    const error = await loadConfig(definition([await fileSource(content)])).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(ErrConfigValidation)
    expect((error as ErrConfigValidation).issues.map(issue => [issue.path, issue.code])).toEqual([
      ['db.password', 'ERR_CONFIG_INTERPOLATION'],
      ['db.url', 'ERR_CONFIG_INTERPOLATION'],
    ])
    expect((error as Error).message).toContain(UNSET)
    expect((error as Error).message).not.toContain('s3cret')
  })

  it('shows the file layer as written and the value interpolated', async () => {
    const file = await fileSource({ db: { host: 'h', url: 'postgres://${config:db.host}/app' } })

    const store = await loadConfig(definition([file]))

    expect(store.explain('db.url')).toMatchObject({
      value: 'postgres://h/app',
      layers: [{ value: 'postgres://${config:db.host}/app' }],
    })
  })

  // The application reads its own `caffeine` block off the merged tree before validation: interpolated as well.
  it('interpolates the tree the application reads its own block from', async () => {
    const store = await loadConfig(definition([await fileSource({ caffeine: { name: `\${env:${UNSET}:-svc}` } })]))

    expect(readPath(store[kMergedTree], ['caffeine', 'name'])).toBe('svc')
  })

  // Only a layer that says so interpolates, however it reaches the store.
  it('interpolates a source of your own only when its layer says so', async () => {
    const custom = (interpolate?: boolean): ConfigSource => ({
      name: 'custom',
      load: (): ConfigLayer[] => [{ name: 'custom', data: { a: `\${env:${UNSET}:-d}` }, interpolate }],
    })

    expect((await loadConfig(definition([custom()]))).current).toEqual({ a: `\${env:${UNSET}:-d}` })
    expect((await loadConfig(definition([custom(true)]))).current).toEqual({ a: 'd' })
  })

  it('reads a file as written when told not to interpolate', async () => {
    const store = await loadConfig(definition([await fileSource({ a: '${not a placeholder' }, { interpolate: false })]))

    expect(store.current).toEqual({ a: '${not a placeholder' })
  })
})

describe('ConfigStore interpolation on reload', () => {
  it('fills a value in again when a value it refers to changes', async () => {
    const { source, state } = liveSource('remote', { db: { host: 'h1' } })
    const store = await loadConfig(
      definition([await fileSource({ db: { url: 'postgres://${config:db.host}/app' } }), source]),
    )
    const listener = vi.fn()
    store.onChange(listener)

    state.data = { db: { host: 'h2' } }
    const outcome = await store.reload()

    expect(outcome.status).toBe('applied')
    expect(outcome.changed).toEqual(expect.arrayContaining(['db.host', 'db.url']))
    expect(store.current).toMatchObject({ db: { url: 'postgres://h2/app' } })
    await vi.waitFor(() => expect(listener).toHaveBeenCalled())
  })

  it('rejects a reload that leaves a value impossible to fill in, keeping the old one and logging no value', async () => {
    vi.stubEnv('TOKEN', 'super-s3cret')
    const logger = new RecordingLogger()
    const { source, state } = liveSource('remote', { db: { host: 'h1' } })
    const file = await fileSource({ db: { url: 'postgres://u:${env:TOKEN}@${config:db.host}/app' } })
    const store = await loadConfig(definition([file, source]), { logger })

    state.data = { db: {} }
    const outcome = await store.reload()

    expect(outcome.status).toBe('rejected')
    expect(outcome.error?.issues).toMatchObject([{ path: 'db.url', code: 'ERR_CONFIG_INTERPOLATION' }])
    expect(store.current).toMatchObject({ db: { url: 'postgres://u:super-s3cret@h1/app' } })

    const [record] = logger.at('error')
    expect(record.msg).toBe('configuration reload rejected')
    expect(JSON.stringify(record.fields)).not.toContain('s3cret')
  })

  it('keeps the last good layers of a watched file edited into a malformed placeholder', async () => {
    const path = await write('watched.json', { a: `\${env:${UNSET}:-first}` })
    const store = await loadConfig(definition([new JSONConfigSource(path, { watch: true })]), { start: false })

    await write('watched.json', { a: '${evn:NAME}' })
    const outcome = await store.reload()

    expect(outcome.failures).toMatchObject([{ error: { code: 'ERR_CONFIG_INTERPOLATION' } }])
    expect(store.current).toEqual({ a: 'first' })
    await store.close()
  })
})
