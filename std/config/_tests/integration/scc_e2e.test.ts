import { CaffeineIoC, token } from '@caffeinejs/di'
import { beforeAll, describe, expect, it } from 'vitest'
import type { ConfigHandle } from '../../accessor.js'
import type { ConfigSchema } from '../../schema.js'
import { bootstrapConfig } from '../../bootstrap.js'
import { CONFIG_REFRESH_LABEL, ConfigModule } from '../../integration/module.js'
import { InlineConfigProvider } from '../../providers/inline_provider.js'
import { SpringCloudConfigProvider } from '../../index.js'
import type { SpringCloudConfigProviderOptions } from '../../providers/scc_provider.js'

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

// Passthrough: the config server returns dynamic, loosely-typed data, so this Standard Schema accepts it as-is.
const schema: ConfigSchema<CaffeineConfig> = {
  '~standard': {
    version: 1,
    vendor: 'caffeine-test',
    validate: (input: unknown) => ({ value: input as CaffeineConfig }),
  },
}

async function isServerAvailable(): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    const res = await fetch(`${CONFIGSERVER_URL}/actuator/health`, { signal: ctrl.signal })
    return res.ok
  } catch {
    return false
  }
}

function makeProvider(overrides: Partial<SpringCloudConfigProviderOptions> = {}): SpringCloudConfigProvider {
  return new SpringCloudConfigProvider({
    baseURLs: [CONFIGSERVER_URL],
    basicAuth: { username: CONFIGSERVER_USERNAME, password: CONFIGSERVER_PASSWORD },
    timeoutMs: TIMEOUT_MS,
    retries: 0,
    ...overrides,
  })
}

let serverAvailable = false

beforeAll(async () => {
  serverAvailable = await isServerAvailable()
  if (!serverAvailable) {
    console.warn(`[scc_e2e] Config Server not reachable at ${CONFIGSERVER_URL} — skipping e2e tests`)
  }
})

describe('SpringCloudConfigProvider e2e', () => {
  it('resolves default props from /caffeine/default', async () => {
    if (!serverAvailable) {
      return
    }

    const result = await bootstrapConfig({
      providers: [makeProvider()],
      schema,
      context: { app: 'caffeine', profiles: ['default'] },
    })

    expect(result.config.caffeine.version).toBe('1.0.0')
  })

  it('resolves dev overlay from /caffeine/dev', async () => {
    if (!serverAvailable) {
      return
    }

    const result = await bootstrapConfig({
      providers: [makeProvider()],
      schema,
      context: { app: 'caffeine', profiles: ['dev'] },
    })

    expect(result.config.caffeine.environment).toBe('development')
  })

  it('resolves prod overlay from /caffeine/prod', async () => {
    if (!serverAvailable) {
      return
    }

    const result = await bootstrapConfig({
      providers: [makeProvider()],
      schema,
      context: { app: 'caffeine', profiles: ['prod'] },
    })

    expect(result.config.caffeine.environment).toBe('production')
  })

  it('fails over to second URL when first is unreachable', async () => {
    if (!serverAvailable) {
      return
    }

    const result = await bootstrapConfig({
      providers: [makeProvider({ baseURLs: ['http://localhost:19999', CONFIGSERVER_URL] })],
      schema,
      context: { app: 'caffeine', profiles: ['default'] },
    })

    expect(result.config.caffeine.version).toBe('1.0.0')
  })

  it('throws ERR_CONFIG_PROVIDER immediately on wrong credentials (no retry)', async () => {
    if (!serverAvailable) {
      return
    }

    const provider = makeProvider({
      basicAuth: { username: 'wrong', password: 'wrong' },
      retries: 3,
      optional: false,
    })

    await expect(
      bootstrapConfig({
        providers: [provider],
        schema,
        context: { app: 'caffeine', profiles: ['default'] },
      }),
    ).rejects.toMatchObject({ name: 'ErrConfig', code: 'ERR_CONFIG_PROVIDER' })
  })
})

describe('Refresh e2e with live proxy', () => {
  it('live proxy reflects new values after container refresh', async () => {
    if (!serverAvailable) {
      return
    }

    let inlineOverride: Record<string, unknown> = {}

    const mutableInline = {
      id: 'mutable-inline',
      load: async () =>
        new InlineConfigProvider(inlineOverride as never).load({ app: 'caffeine', profiles: ['default'] }),
    }

    const APP_TOKEN = token<any>(Symbol('caffeine.config'))
    const container = new CaffeineIoC()
    container.addModules(
      ConfigModule<CaffeineConfig>({
        token: APP_TOKEN,
        schema,
        providers: [
          mutableInline,
          makeProvider(),
        ],
        context: { app: 'caffeine', profiles: ['default'] },
      }),
    )
    await container.init()

    const config = container.get<ConfigHandle<CaffeineConfig>>(APP_TOKEN)
    expect(config.caffeine.version).toBe('1.0.0')

    inlineOverride = { caffeine: { version: '99.0.0' } }
    await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    expect(config.caffeine.version).toBe('99.0.0')
  })
})
