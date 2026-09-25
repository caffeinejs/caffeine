import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CaffeineIoC, token } from '@caffeinejs/di'
import { Controller, Get, Router, createWebApplication } from '@caffeinejs/http'
import { newConfiguration } from '@caffeinejs/std'
import {
  ConfigStore,
  EnvConfigSource,
  InlineConfigSource,
  JSONConfigSource,
  SpringCloudConfigSource,
  type ConfigSource,
  type InferConfig,
} from '@caffeinejs/std/config'
import { $t } from '@caffeinejs/std/schema'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  CONFIG_SERVER,
  CONFIG_SERVER_AUTH,
  configServerServesRuntime,
  removeServerFiles,
  writeServerFile,
} from './internal/configserver/index.js'
import { required } from './internal/strict.js'

const APP = 'e2e-web'
const WAIT = { timeout: 10_000, interval: 100 }

const schema = $t.Object({
  banner: $t.String(),
  region: $t.String(),
  greeting: $t.String(),
  server: $t.Object({ port: $t.Number() }),
  features: $t.Object({ beta: $t.Boolean() }),
  limits: $t.Object({ rps: $t.Number() }),
  db: $t.Object({ url: $t.String(), password: $t.String() }),
})

type AppConfig = InferConfig<typeof schema>

const kConfig = token<AppConfig>(Symbol('e2e.config'))

// The lowest source sets every key, so each source above it shows the one step of precedence it wins.
const defaults = {
  banner: 'caffeine',
  region: 'local',
  greeting: 'hello from the defaults',
  server: { port: 3000 },
  features: { beta: false },
  limits: { rps: 10 },
  db: { url: 'postgres://localhost/app', password: 'dev' },
}

// The config server's base file for the application. The tests edit `rps` in it while the application polls.
function serverBase(rps: number | string = 100): string {
  return [
    'greeting: hello from the config server',
    'server:',
    '  port: 8080',
    'limits:',
    `  rps: ${rps}`,
    'db:',
    '  url: postgres://db.internal/app',
    '  password: s3cr3t',
    '',
  ].join('\n')
}

const serverDev = 'greeting: hello from the dev overlay\n'

let built = 0

// A singleton, built once: it reads the configuration through the object it was injected with.
@Controller('/greeting', [kConfig])
class GreetingController {
  readonly #instance = ++built

  constructor(private readonly config: AppConfig) {}

  @Get('/')
  greet() {
    return { greeting: this.config.greeting, rps: this.config.limits.rps, instance: this.#instance }
  }
}

void [GreetingController]

// A request handler reads the snapshot of the revision its request started on. The secret is never sent.
const routes = new Router('/config').configType<AppConfig>().get('/', ctx => {
  const c = ctx.config
  return {
    banner: c.banner,
    region: c.region,
    greeting: c.greeting,
    port: c.server.port,
    beta: c.features.beta,
    rps: c.limits.rps,
    dbURL: c.db.url,
  }
})

function buildApp(fileDir: string, overrides: ConfigSource) {
  const conf = newConfiguration(schema, kConfig)
    .sources(
      new InlineConfigSource(defaults, 'defaults'),
      new JSONConfigSource(join(fileDir, 'config.json')),
      new SpringCloudConfigSource({
        app: APP,
        baseURLs: [CONFIG_SERVER],
        basicAuth: CONFIG_SERVER_AUTH,
        pollInterval: 250,
        retries: 0,
        timeoutMs: 3_000,
      }),
      new EnvConfigSource({ prefix: 'E2E_', env: { E2E_SERVER__PORT: '8081', E2E_FEATURES__BETA: 'false' } }),
    )
    .args({ argv: ['--features.beta=true'] })
    .source(overrides)
    .build()

  return createWebApplication({
    container: new CaffeineIoC({ profiles: ['dev'] }),
    config: conf,
  }).mount(routes)
}

const up = required('configserver', await configServerServesRuntime())

describe.skipIf(!up)('a web application configured from a config server and five other sources', () => {
  // A source written at run time. It says when it changed, and the store loads it again by itself.
  let overridden: Record<string, unknown> = {}
  let changed: (() => void) | undefined
  const overrides: ConfigSource = {
    name: 'overrides',
    load: () => [{ name: 'overrides', data: structuredClone(overridden) as never }],
    watch: listener => {
      changed = listener
      return () => {
        changed = undefined
      }
    },
  }
  function override(values: Record<string, unknown>): void {
    overridden = values
    changed?.()
  }

  let dir: string | undefined
  let app: ReturnType<typeof buildApp>
  let store: ConfigStore<AppConfig>

  async function json(path: string): Promise<Record<string, unknown>> {
    return (await (await app.fetch(path)).json()) as Record<string, unknown>
  }

  async function waitForRPS(rps: number): Promise<void> {
    await vi.waitFor(async () => expect(await json('/config')).toMatchObject({ rps }), WAIT)
  }

  // Puts the server back to its base file, so each test starts where the first one did.
  async function restore(): Promise<void> {
    await writeServerFile(`${APP}.yml`, serverBase())
    await waitForRPS(100)
  }

  beforeAll(async () => {
    await writeServerFile(`${APP}.yml`, serverBase())
    await writeServerFile(`${APP}-dev.yml`, serverDev)
    dir = await mkdtemp(join(tmpdir(), 'caffeine-config-e2e-'))
    await writeFile(join(dir, 'config.json'), JSON.stringify({ region: 'eu-west', greeting: 'hello from the file' }))
    await writeFile(join(dir, 'config-dev.json'), JSON.stringify({ region: 'eu-central' }))

    app = buildApp(dir, overrides)
    await app.ready()
    store = app.container.get(ConfigStore) as ConfigStore<AppConfig>
  })

  afterAll(async () => {
    await app?.close()
    await removeServerFiles(`${APP}.yml`, `${APP}-dev.yml`)
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // Six sources set overlapping keys. Each value comes from the last source that sets it, the config server and the
  // file both answered for the active profile, and text from the environment and the command line arrives typed.
  it('serves each setting from the last source that sets it, under the active profile', async () => {
    expect(await json('/config')).toEqual({
      banner: 'caffeine',
      region: 'eu-central',
      greeting: 'hello from the dev overlay',
      port: 8081,
      beta: true,
      rps: 100,
      dbURL: 'postgres://db.internal/app',
    })
  })

  // Whoever asks where a value came from is pointed at the config server's file, and sees what each source held,
  // the losing ones included.
  it('traces a setting to the config server file that set it, with what each source held', () => {
    expect(store.explain('greeting').layers.map(layer => layer.origin)).toEqual([
      expect.stringMatching(/^spring-cloud-config:.*e2e-web-dev\.yml/),
      expect.stringMatching(/^spring-cloud-config:.*e2e-web\.yml/),
      expect.stringMatching(/^file:.*config\.json$/),
      'defaults',
    ])

    const password = store.explain('db.password')
    expect(password.value).toBe('s3cr3t')
    expect(password.layers.map(layer => layer.value)).toEqual(['s3cr3t', 'dev'])
  })

  // The point of a live source: an operator edits the config server, and the running application serves the new
  // value, both to a request handler and to a singleton that was handed its configuration once.
  it('follows a value edited on the config server, with no restart', async () => {
    const before = await json('/greeting')
    const revision = store.revision

    await writeServerFile(`${APP}.yml`, serverBase(250))

    await vi.waitFor(async () => expect(await json('/greeting')).toEqual({ ...before, rps: 250 }), WAIT)
    expect(await json('/config')).toMatchObject({ rps: 250 })
    expect(store.revision).toBeGreaterThan(revision)

    await restore()
  })

  // A reload is all or nothing: one bad value on the server keeps the whole application on its last good revision,
  // and the next good value is applied as usual.
  it('keeps serving the last good values while the config server sends an invalid one', async () => {
    await writeServerFile(`${APP}.yml`, serverBase('lots'))

    expect((await store.reload()).status).toBe('rejected')
    expect(await json('/config')).toMatchObject({ rps: 100 })

    await writeServerFile(`${APP}.yml`, serverBase(150))
    await waitForRPS(150)

    await restore()
  })

  // An override set at run time outranks every source, the config server included, until it is removed.
  it('lets a runtime override win over the config server, and falls back when it is removed', async () => {
    override({ limits: { rps: 999 } })
    await waitForRPS(999)

    await writeServerFile(`${APP}.yml`, serverBase(300))
    await store.reload()
    expect(await json('/config')).toMatchObject({ rps: 999 })

    override({})
    await waitForRPS(300)

    await restore()
  })
})
