import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse as parseYAML } from 'yaml'

import { $t } from '../../schema/t.js'
import { ErrConfigValidation } from '../errors.js'
import { mergeInterpolated } from '../interpolation.js'
import { loadConfig } from '../load.js'
import { passthroughConfigSchema } from '../schema.js'
import { EnvConfigSource } from '../sources/env_source.js'
import { FileConfigSource, type ConfigFileParser } from '../sources/file_source.js'
import type { ConfigDefinition, ConfigLoadContext, ConfigSchema, ConfigSource, InferConfig } from '../types.js'

const fixtures = fileURLToPath(new URL('./_testdata/yaml', import.meta.url))

const yaml: ConfigFileParser = text => parseYAML(text) as Record<string, unknown>

// YAML 1.2 has no merge key: `<<` is a key like any other unless the parser is told otherwise.
const yamlWithMergeKeys: ConfigFileParser = text => parseYAML(text, { merge: true }) as Record<string, unknown>

function context(): ConfigLoadContext {
  return { profiles: [], signal: new AbortController().signal, logger: undefined as never }
}

function definition<T = Record<string, unknown>>(
  sources: ConfigSource[],
  schema: ConfigSchema<T> = passthroughConfigSchema as ConfigSchema<T>,
): ConfigDefinition<T> {
  return { schema, key: undefined, storeKey: undefined, sources, loadTimeoutMs: 30_000 }
}

/** Reads a fixture as a file source does, then interpolates it against `env` alone. */
async function interpolateFixture(
  name: string,
  env: Record<string, string>,
  parse: ConfigFileParser = yaml,
): Promise<Record<string, unknown>> {
  const layers = await new FileConfigSource(join(fixtures, name), parse).load(context())
  return mergeInterpolated(layers, env) as Record<string, unknown>
}

const appSchema = $t.Object({
  caffeine: $t.Object({ name: $t.String() }),
  server: $t.Object({ host: $t.String(), port: $t.Number(), shutdownDelay: $t.Duration() }),
  db: $t.Object({
    host: $t.String(),
    port: $t.Number(),
    name: $t.String(),
    user: $t.String(),
    password: $t.String(),
    url: $t.String(),
    pool: $t.Object({ max: $t.Number(), ssl: $t.Boolean() }),
  }),
  features: $t.Object({ search: $t.String(), allowedOrigins: $t.Array($t.String()) }),
  banner: $t.String(),
  templates: $t.Object({ greeting: $t.String() }),
  messaging: $t.Object({ queue: $t.String(), deadLetter: $t.String() }),
})

type App = InferConfig<typeof appSchema>

// Every variable the application reads. Unset before each test, so the machine running it decides nothing.
const APP_VARIABLES = [
  'SERVICE_NAME',
  'HOST',
  'PORT',
  'SHUTDOWN_DELAY',
  'DB_USER',
  'POOL_MAX',
  'DB_SSL',
  'SEARCH_BACKEND',
  'DOMAIN',
  'DB_HOST',
  'DB_PASSWORD',
]

function application(...later: ConfigSource[]): ConfigDefinition<App> {
  return definition<App>(
    [
      new FileConfigSource(join(fixtures, 'app', 'application.yaml'), yaml),
      new FileConfigSource(join(fixtures, 'app', 'messaging.yaml'), yaml),
      ...later,
    ],
    appSchema,
  )
}

describe('a YAML application', () => {
  beforeEach(() => {
    for (const name of APP_VARIABLES) {
      vi.stubEnv(name, undefined)
    }
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('runs on its own defaults when the environment sets nothing', async () => {
    const store = await loadConfig(application())

    expect(store.current).toEqual({
      caffeine: { name: 'orders' },
      server: { host: '0.0.0.0', port: 8080, shutdownDelay: 5000 },
      db: {
        host: 'localhost',
        port: 5432,
        name: 'orders',
        user: 'orders',
        password: 'dev-password',
        url: 'postgres://orders@localhost:5432/orders',
        pool: { max: 10, ssl: false },
      },
      features: { search: 'search-local', allowedOrigins: ['https://localhost', 'https://admin.localhost'] },
      banner: 'orders listening on 0.0.0.0:8080\nEvents go to orders.events\n',
      templates: { greeting: 'Hello ${user.name}' },
      messaging: { queue: 'orders.events', deadLetter: 'orders.events.dlq' },
    })
  })

  it('carries the environment into every value built from it', async () => {
    vi.stubEnv('SERVICE_NAME', 'payments')
    vi.stubEnv('PORT', '9090')
    vi.stubEnv('SHUTDOWN_DELAY', '1m')
    vi.stubEnv('DOMAIN', 'example.com')
    vi.stubEnv('POOL_MAX', '25')
    vi.stubEnv('DB_SSL', 'true')

    const store = await loadConfig(application())

    expect(store.current).toMatchObject({
      server: { port: 9090, shutdownDelay: 60_000 },
      db: { pool: { max: 25, ssl: true } },
      features: { allowedOrigins: ['https://example.com', 'https://admin.example.com'] },
      banner: 'payments listening on 0.0.0.0:9090\nEvents go to payments.events\n',
      messaging: { queue: 'payments.events', deadLetter: 'payments.events.dlq' },
    })
  })

  // Production takes its database from the environment and nowhere else, and every value that needs it says so.
  it('fails under prod until the environment names the database', async () => {
    const error = await loadConfig(application(), { profiles: ['prod'] }).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(ErrConfigValidation)
    const issues = (error as ErrConfigValidation).issues
    expect(issues.map(issue => issue.path)).toEqual(['db.host', 'db.password', 'db.url'])
    for (const issue of issues) {
      expect(issue.message).toContain(join(fixtures, 'app', 'application-prod.yaml'))
    }
    expect(issues[2].message).toContain('at "db.host"')
  })

  it('reads the database from the environment under prod', async () => {
    vi.stubEnv('DB_HOST', 'db.internal')
    vi.stubEnv('DB_PASSWORD', 's3cret')

    const store = await loadConfig(application(), { profiles: ['prod'] })

    expect(store.current.db).toEqual({
      host: 'db.internal',
      port: 5432,
      name: 'orders',
      user: 'orders',
      password: 's3cret',
      url: 'postgres://orders@db.internal:5432/orders',
      pool: { max: 10, ssl: true },
    })
  })

  it('builds on a value a source registered later overrides', async () => {
    const env = new EnvConfigSource({ prefix: 'APP_', env: { APP_DB__PORT: '6432' } })

    const store = await loadConfig(application(env))

    expect(store.current.db).toMatchObject({ port: 6432, url: 'postgres://orders@localhost:6432/orders' })
  })

  it('explains a value by the template the file holds', async () => {
    const store = await loadConfig(application())

    expect(store.explain('db.url')).toMatchObject({
      value: 'postgres://orders@localhost:5432/orders',
      layers: [{ value: 'postgres://${config:db.user}@${config:db.host}:${config:db.port}/${config:db.name}' }],
    })
  })
})

describe('YAML syntax', () => {
  const rows: [string, unknown][] = [
    ['plain', 'n'],
    ['plainSpacedDefault', 'No Name'],
    ['plainURL', 'postgres://n:5432/app'],
    ['quotedDefault', 'a: b # c'],
    ['apostrophe', "it's n"],
    ['escapeSequence', 'n\nn'],
    ['escapedPlain', '${env:NAME}'],
    ['escapedQuoted', '${env:NAME}'],
    ['literal', 'Hi n\nBye\n'],
    ['literalStrip', 'Hi n\nBye'],
    ['folded', 'Hi n and bye\n'],
    ['tagged', 'n'],
    ['flow', ['n', 'x-n']],
    ['commented', 'n'],
    ['${key}', 'n'],
    ['tilde', null],
    ['empty', null],
    ['nullWord', null],
    ['fromTilde', 'd'],
    ['fromEmpty', 'd'],
    ['fromNull', 'd'],
    ['port', 8080],
    ['enabled', true],
    ['fromNumber', 'port 8080'],
    ['fromBoolean', 'true'],
  ]

  let out: Record<string, unknown>

  beforeAll(async () => {
    out = await interpolateFixture('syntax.yaml', { NAME: 'n' })
  })

  // The rows are the whole file: a style added to it without a row here would be checked by nothing.
  it('reads every key of the fixture', () => {
    expect(Object.keys(out)).toEqual(rows.map(([key]) => key))
  })

  it.each(rows)('reads %s as %j', (key, expected) => {
    expect(out[key]).toEqual(expected)
  })
})

describe('YAML anchors and merge keys', () => {
  it('interpolates an alias at every path it is copied to', async () => {
    const out = await interpolateFixture('anchors.yaml', {}, yamlWithMergeKeys)

    expect(out.primary).toEqual({ host: 'localhost', port: 5432, url: 'postgres://localhost:5432/app' })
    expect(out.replica).toEqual(out.primary)
  })

  // A merge key copies a placeholder's text, and a config path is absolute: the copy still reads the path it names,
  // whatever the map it landed in overrides.
  it('keeps a merged reference pointing at the path it names', async () => {
    const out = await interpolateFixture('anchors.yaml', {}, yamlWithMergeKeys)

    expect(out.reporting).toEqual({ host: 'reporting.internal', port: 5432, url: 'postgres://localhost:5432/app' })
  })

  it('carries the environment into every copy', async () => {
    const out = await interpolateFixture('anchors.yaml', { DB_HOST: 'db.internal' }, yamlWithMergeKeys)

    expect(out).toEqual({
      primary: { host: 'db.internal', port: 5432, url: 'postgres://db.internal:5432/app' },
      replica: { host: 'db.internal', port: 5432, url: 'postgres://db.internal:5432/app' },
      reporting: { host: 'reporting.internal', port: 5432, url: 'postgres://db.internal:5432/app' },
    })
  })
})

describe('YAML mistakes', () => {
  const mistake = (name: string): string => join(fixtures, 'mistakes', name)

  // Unquoted, ` #` opens a YAML comment and cuts the placeholder short. What would have been a wrong value is an error
  // that names the file.
  it('refuses a placeholder a YAML comment cut short', async () => {
    const path = mistake('comment-in-default.yaml')

    await expect(new FileConfigSource(path, yaml).load(context())).rejects.toThrow(
      `Cannot interpolate "greeting" in config file "${path}": the placeholder at character 1 is not closed`,
    )
  })

  it('counts the character across the lines of a block', async () => {
    const path = mistake('malformed-in-block.yaml')

    await expect(new FileConfigSource(path, yaml).load(context())).rejects.toThrow(
      `Cannot interpolate "script" in config file "${path}": the placeholder at character 17 has a prefix other than "env" or "config"`,
    )
  })

  it('refuses a placeholder in caffeine.profiles', async () => {
    const path = mistake('profiles-placeholder.yaml')

    await expect(new FileConfigSource(path, yaml).load(context())).rejects.toThrow(
      `Cannot interpolate "caffeine.profiles" in config file "${path}"`,
    )
  })

  it('refuses a null a placeholder reads without a default', async () => {
    const error = await interpolateFixture('mistakes/null-without-default.yaml', {}).catch((thrown: unknown) => thrown)

    expect((error as ErrConfigValidation).issues).toEqual([
      {
        path: 'a',
        message: `cannot interpolate "\${config:nothing}" from "file:${mistake('null-without-default.yaml')}": "nothing" is not set`,
        code: 'ERR_CONFIG_INTERPOLATION',
      },
    ])
  })

  describe('in YAML that does not parse', () => {
    let dir: string

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'caffeine-config-'))
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    // A formatter either refuses these or rewrites them into valid YAML that means something else, so they cannot be
    // kept as files: each is written out as the test runs.
    it.each([
      ['a ": " in an unquoted default', 'title: ${env:TITLE:-Caffeine: the framework}'],
      ['an unquoted placeholder in a flow sequence', 'origins: [${env:ORIGIN}]'],
      ['an unquoted placeholder in a flow mapping', 'db: { host: ${env:DB_HOST} }'],
      ['a backslash before a placeholder in double quotes', 'literal: "\\${env:NAME}"'],
    ])('fails to parse %s, naming the file', async (_label, text) => {
      const path = join(dir, 'app.yaml')
      await writeFile(path, `${text}\n`, 'utf8')

      const error = await new FileConfigSource(path, yaml).load(context()).catch((thrown: unknown) => thrown)

      expect(error).toMatchObject({ code: 'ERR_CONFIG_FILE_PARSE' })
      expect((error as Error).message).toContain(path)
    })
  })
})

describe('a YAML file on reload', () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    vi.stubEnv('REGION', undefined)
    dir = await mkdtemp(join(tmpdir(), 'caffeine-config-'))
    path = join(dir, 'application.yaml')
    await copyFile(join(fixtures, 'reload.yaml'), path)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(dir, { recursive: true, force: true })
  })

  function watched() {
    return loadConfig(definition([new FileConfigSource(path, yaml, { watch: true })]), { start: false })
  }

  it('interpolates an edited file again', async () => {
    const store = await watched()
    expect(store.current).toEqual({ region: 'eu', bucket: 'data-eu' })

    await copyFile(join(fixtures, 'reload-edited.yaml'), path)
    const outcome = await store.reload()

    expect(outcome.status).toBe('applied')
    expect(store.current).toEqual({ region: 'us', bucket: 'data-us' })
    await store.close()
  })

  it('keeps the last good values through an edit YAML cuts short', async () => {
    const store = await watched()

    await copyFile(join(fixtures, 'mistakes', 'comment-in-default.yaml'), path)
    const outcome = await store.reload()

    expect(outcome.failures).toMatchObject([{ error: { code: 'ERR_CONFIG_INTERPOLATION' } }])
    expect(store.current).toEqual({ region: 'eu', bucket: 'data-eu' })
    await store.close()
  })
})
