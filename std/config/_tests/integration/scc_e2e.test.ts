import { CaffeineIoC, token } from '@caffeinejs/di'
import { beforeAll, describe, expect, it } from 'vitest'

import { CONFIG_REFRESH_LABEL, ConfigModule } from '../../integration/module.js'
import { loadConfig } from '../../load.js'
import {
  SpringCloudConfigSource,
  type SpringCloudConfigSourceOptions,
} from '../../sources/spring_cloud_config_source.js'
import type { ConfigSchema, ConfigSource } from '../../types.js'

// Runs against a real config server when one answers. Without one every test here is reported as skipped.
const CONFIGSERVER_URL = process.env['CONFIGSERVER_URL'] ?? 'http://localhost:8888'
const CONFIGSERVER_USERNAME = process.env['CONFIGSERVER_USERNAME'] ?? 'configuser'
const CONFIGSERVER_PASSWORD = process.env['CONFIGSERVER_PASSWORD'] ?? 'configpass'
const TIMEOUT_MS = 3_000

interface CaffeineConfig {
  caffeine: {
    greeting?: string
    version?: string
    environment?: string
    debug?: boolean
    app?: string
    secret?: string
  }
}

// The config server returns loosely typed data, so this schema accepts it as it is.
const schema: ConfigSchema<CaffeineConfig> = {
  '~standard': {
    version: 1,
    vendor: 'caffeine-test',
    validate: (input: unknown) => ({ value: input as CaffeineConfig }),
  },
}

async function isServerAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${CONFIGSERVER_URL}/actuator/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    return response.ok
  } catch {
    return false
  }
}

function server(overrides: Partial<SpringCloudConfigSourceOptions> = {}): SpringCloudConfigSource {
  return new SpringCloudConfigSource({
    app: 'caffeine',
    baseURLs: [CONFIGSERVER_URL],
    basicAuth: { username: CONFIGSERVER_USERNAME, password: CONFIGSERVER_PASSWORD },
    timeoutMs: TIMEOUT_MS,
    retries: 0,
    ...overrides,
  })
}

function load(sources: ConfigSource[], profiles: string[]) {
  return loadConfig<CaffeineConfig>(
    { schema, key: undefined, storeKey: undefined, sources, loadTimeoutMs: 30_000 },
    { profiles, start: false },
  )
}

let serverAvailable = false

beforeAll(async () => {
  serverAvailable = await isServerAvailable()
})

describe('SpringCloudConfigSource against a config server', () => {
  it('loads the default properties', async context => {
    context.skip(!serverAvailable, `no config server at ${CONFIGSERVER_URL}`)

    const store = await load([server()], ['default'])

    expect(store.current.caffeine.version).toBe('1.0.0')
  })

  it('loads the dev overlay', async context => {
    context.skip(!serverAvailable, `no config server at ${CONFIGSERVER_URL}`)

    const store = await load([server()], ['dev'])

    expect(store.current.caffeine.environment).toBe('development')
  })

  it('loads the prod overlay', async context => {
    context.skip(!serverAvailable, `no config server at ${CONFIGSERVER_URL}`)

    const store = await load([server()], ['prod'])

    expect(store.current.caffeine.environment).toBe('production')
  })

  it('fails over to the second URL when the first is unreachable', async context => {
    context.skip(!serverAvailable, `no config server at ${CONFIGSERVER_URL}`)

    const store = await load([server({ baseURLs: ['http://localhost:19999', CONFIGSERVER_URL] })], ['default'])

    expect(store.current.caffeine.version).toBe('1.0.0')
  })

  it('fails at once on wrong credentials, without retrying', async context => {
    context.skip(!serverAvailable, `no config server at ${CONFIGSERVER_URL}`)

    const wrong = server({ basicAuth: { username: 'wrong', password: 'wrong' }, retries: 3 })

    await expect(load([wrong], ['default'])).rejects.toMatchObject({ name: 'ErrConfig', code: 'ERR_CONFIG_SOURCE' })
  })
})

describe('a config server behind a container refresh', () => {
  it('reads new values through the live object after a refresh', async context => {
    context.skip(!serverAvailable, `no config server at ${CONFIGSERVER_URL}`)

    let overridden: Record<string, unknown> = {}
    const overrides: ConfigSource = {
      name: 'overrides',
      live: true,
      load: () => [{ name: 'overrides', data: overridden as never }],
    }
    const kConfig = token<CaffeineConfig>(Symbol('caffeine.config'))
    const store = await loadConfig<CaffeineConfig>(
      { schema, key: kConfig, storeKey: undefined, sources: [server(), overrides], loadTimeoutMs: 30_000 },
      { profiles: ['default'], start: false },
    )
    const container = new CaffeineIoC({ decorators: false })
    container.addModules(ConfigModule(store))
    await container.init()

    const config = container.get(kConfig)
    expect(config.caffeine.version).toBe('1.0.0')

    overridden = { caffeine: { version: '99.0.0' } }
    await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    expect(config.caffeine.version).toBe('99.0.0')
  })
})
