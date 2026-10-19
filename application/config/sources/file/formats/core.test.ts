import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { $t } from '../../../../schema/t.js'
import { ErrConfigValidation } from '../../../errors.js'
import { loadConfig } from '../../../load.js'
import type { ConfigDefinition, ConfigSource, InferConfig } from '../../../types.js'
import { EnvConfigSource } from '../../env/index.js'
import { context, definition, fixture, FORMATS, interpolateFixture } from './formats.testkit.js'

// What a file means must not depend on the format it is written in. Every scenario here runs once per format, over
// the same core set of files, and expects the same result.

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

describe.each(FORMATS)('$name', format => {
  function application(...later: ConfigSource[]): ConfigDefinition<App> {
    return definition<App>(
      [format.source(fixture(format, 'app/application')), format.source(fixture(format, 'app/messaging')), ...later],
      appSchema,
    )
  }

  describe('an application', () => {
    beforeEach(() => {
      for (const name of APP_VARIABLES) {
        vi.stubEnv(name, undefined)
      }
    })

    afterEach(() => {
      vi.unstubAllEnvs()
    })

    // The banner reads the second file, and the second file reads the first.
    it('runs on its own defaults, across two files that read each other', async () => {
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
        expect(issue.message).toContain(fixture(format, 'app/application-prod'))
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

  describe('values', () => {
    const rows: [string, unknown][] = [
      ['plain', 'n'],
      ['spacedDefault', 'No Name'],
      ['url', 'postgres://n:5432/app'],
      ['escaped', '${env:NAME}'],
      // Escaped text stays text, even when another placeholder reads it.
      ['fromEscaped', '${env:NAME}'],
      // A key is never interpolated.
      ['${key}', 'n'],
      ['list', ['n', 'x-n']],
      ['nested', { deep: 'n' }],
      ['nothing', null],
      ['fromNothing', 'd'],
      ['port', 8080],
      ['fromNumber', 'port 8080'],
      ['enabled', true],
      ['fromBoolean', 'true'],
    ]

    let out: Record<string, unknown>

    beforeAll(async () => {
      out = await interpolateFixture(format, 'values', { NAME: 'n' })
    })

    // The rows are the whole file: a value added to it without a row here would be checked by nothing.
    it('reads every key of the fixture', () => {
      expect(Object.keys(out)).toEqual(rows.map(([key]) => key))
    })

    it.each(rows)('reads %s as %j', (key, expected) => {
      expect(out[key]).toEqual(expected)
    })
  })

  // A placeholder is filled in only where it decides a value: a base file's secret reference, overridden for local
  // development, must not demand a variable nobody sets locally.
  describe('a profile file', () => {
    it('needs a variable only where no profile file replaces the placeholder', async () => {
      expect(await interpolateFixture(format, 'lazy/app', {}, ['dev'])).toEqual({ db: { password: 'dev' } })

      const error = await interpolateFixture(format, 'lazy/app', {}).catch((thrown: unknown) => thrown)

      expect((error as ErrConfigValidation).issues).toEqual([
        {
          path: 'db.password',
          message: `cannot interpolate "\${env:DB_PASSWORD}" from "file:${fixture(format, 'lazy/app')}": the environment variable is not set`,
          code: 'ERR_CONFIG_INTERPOLATION',
        },
      ])
    })
  })

  describe('mistakes', () => {
    // A file's placeholders are checked as it is read. The error names the file, the path and the character, and
    // never the text: it may be a secret.
    it('refuses a malformed placeholder as the file is read', async () => {
      const path = fixture(format, 'mistakes/malformed')

      const error = await format
        .source(path)
        .load(context())
        .catch((thrown: unknown) => thrown)

      expect(error).toMatchObject({ code: 'ERR_CONFIG_INTERPOLATION' })
      expect((error as Error).message).toContain(
        `Cannot interpolate "db.password" in config file "${path}": the placeholder at character 7 has a prefix other than "env" or "config"`,
      )
      expect((error as Error).message).not.toContain('hunter')
    })

    it('refuses a null a placeholder reads without a default', async () => {
      const error = await interpolateFixture(format, 'mistakes/null-without-default', {}).catch(
        (thrown: unknown) => thrown,
      )

      expect((error as ErrConfigValidation).issues).toEqual([
        {
          path: 'a',
          message: `cannot interpolate "\${config:nothing}" from "file:${fixture(format, 'mistakes/null-without-default')}": "nothing" is not set`,
          code: 'ERR_CONFIG_INTERPOLATION',
        },
      ])
    })
  })

  describe('reload', () => {
    let dir: string
    let path: string

    beforeEach(async () => {
      vi.stubEnv('REGION', undefined)
      dir = await mkdtemp(join(tmpdir(), 'caffeine-config-'))
      path = join(dir, `application.${format.ext}`)
      await copyFile(fixture(format, 'reload'), path)
    })

    afterEach(async () => {
      vi.unstubAllEnvs()
      await rm(dir, { recursive: true, force: true })
    })

    function watched() {
      return loadConfig(definition([format.source(path, { watch: true })]), { start: false })
    }

    it('interpolates an edited file again', async () => {
      const store = await watched()
      expect(store.current).toEqual({ region: 'eu', bucket: 'data-eu' })

      await copyFile(fixture(format, 'reload-edited'), path)
      const outcome = await store.reload()

      expect(outcome.status).toBe('applied')
      expect(store.current).toEqual({ region: 'us', bucket: 'data-us' })
      await store.close()
    })

    it('keeps the last good values through an edit into a malformed placeholder', async () => {
      const store = await watched()

      await copyFile(fixture(format, 'mistakes/malformed'), path)
      const outcome = await store.reload()

      expect(outcome.failures).toMatchObject([{ error: { code: 'ERR_CONFIG_INTERPOLATION' } }])
      expect(store.current).toEqual({ region: 'eu', bucket: 'data-eu' })
      await store.close()
    })
  })
})
