import { CaffeineIoC, token, opaqueToken } from '@caffeinejs/di'
import { describe, expect, it, vi } from 'vitest'

import { $t } from '../../schema/t.js'
import { Configuration, kConfiguration } from '../configuration.js'
import { ConfigDefinition } from '../definition.js'
import { CONFIG_REFRESH_LABEL, ConfigModule } from '../integration/module.js'
import { MutableConfigProvider } from '../providers/mutable_provider.js'
import { ConfigPriority } from '../sources.js'

const APP_CONFIG = opaqueToken(Symbol('app.config'))

interface App {
  server: { port: number; host: string }
}
interface Server {
  port: number
  host: string
}

const schema = $t.Object({
  server: $t.Object(
    {
      port: $t.Number({ default: 0 }),
      host: $t.String({ default: 'localhost' }),
    },
    { default: {} },
  ),
})

const serverSchema = $t.Object({
  port: $t.Number({ default: 0 }),
  host: $t.String({ default: 'localhost' }),
})

interface Harness {
  container: CaffeineIoC
  definition: ConfigDefinition
  configuration: Configuration<App>
  slice: ReturnType<ConfigDefinition['slice']>
  mutable: MutableConfigProvider
  refresh: () => Promise<void>
}

async function setup(warn?: (message: string) => void): Promise<Harness> {
  const definition = new ConfigDefinition(APP_CONFIG)
  const mutable = new MutableConfigProvider('test')
  mutable.set('server.port', 3000)
  mutable.set('server.host', 'localhost')
  definition.sources.add(mutable, ConfigPriority.ENV)
  definition.schema = schema
  definition.warn = warn
  const slice = definition.slice(['server'], serverSchema)

  const container = new CaffeineIoC({ decorators: false })
  container.addModules(ConfigModule(definition))
  await container.init()

  return {
    container,
    definition,
    configuration: container.get<Configuration<App>>(kConfiguration),
    slice,
    mutable,
    refresh: () => container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol),
  }
}

describe('ConfigSlice.onChange', () => {
  it('is not called at start-up', async () => {
    const { slice } = await setup()
    const seen = vi.fn()

    slice.onChange(seen)

    // The first configuration is what "unchanged" is measured against, not a change in its own right.
    expect(seen).not.toHaveBeenCalled()
  })

  it('delivers the new and the previous configuration on a real change', async () => {
    const { slice, mutable, refresh, configuration } = await setup()
    const seen: Array<[Server, Server]> = []

    slice.onChange((config, previous) => {
      seen.push([config as Server, previous as Server])
    })

    mutable.set('server.port', 8080)
    await refresh()
    await configuration.settled()

    expect(seen).toHaveLength(1)
    expect(seen[0][0].port).toBe(8080)
    expect(seen[0][1].port).toBe(3000)
  })

  it('says nothing when a refresh produced the same values', async () => {
    const { slice, mutable, refresh, configuration } = await setup()
    const seen = vi.fn()

    slice.onChange(seen)

    // A source that reloaded and handed back what it had before is not a change to anybody.
    mutable.set('server.port', 3000)
    await refresh()
    await configuration.settled()

    expect(seen).not.toHaveBeenCalled()
  })

  it('says nothing when some other slice changed', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    const mutable = new MutableConfigProvider('test')
    mutable.set('server.port', 3000)
    mutable.set('other.value', 'a')
    definition.sources.add(mutable, ConfigPriority.ENV)
    definition.schema = $t.Object({})
    const server = definition.slice(['server'], $t.Object({ port: $t.Number({ default: 0 }) }))
    const other = definition.slice(['other'], $t.Object({ value: $t.String({ default: '' }) }))

    const container = new CaffeineIoC({ decorators: false })
    container.addModules(ConfigModule(definition))
    await container.init()

    const serverSeen = vi.fn()
    const otherSeen = vi.fn()
    server.onChange(serverSeen)
    other.onChange(otherSeen)

    mutable.set('other.value', 'b')
    await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)
    await container.get<Configuration<unknown>>(kConfiguration).settled()

    expect(otherSeen).toHaveBeenCalledTimes(1)
    expect(serverSeen).not.toHaveBeenCalled()
  })

  it('stops delivering once unsubscribed', async () => {
    const { slice, mutable, refresh, configuration } = await setup()
    const seen = vi.fn()

    const unsubscribe = slice.onChange(seen)
    unsubscribe()

    mutable.set('server.port', 8080)
    await refresh()
    await configuration.settled()

    expect(seen).not.toHaveBeenCalled()
  })

  it('tells a late subscriber about changes from then on, not before', async () => {
    const { slice, mutable, refresh, configuration } = await setup()

    mutable.set('server.port', 8080)
    await refresh()

    const seen: number[] = []
    slice.onChange(config => {
      seen.push((config as Server).port)
    })

    mutable.set('server.port', 9090)
    await refresh()
    await configuration.settled()

    expect(seen).toEqual([9090])
  })
})

describe('onChange delivery', () => {
  it('does not make the refresh wait', async () => {
    const { slice, mutable, refresh, configuration } = await setup()
    let released: (() => void) | undefined
    const started = vi.fn()
    let finished = false

    slice.onChange(async () => {
      started()
      await new Promise<void>(resolve => {
        released = resolve
      })
      finished = true
    })

    mutable.set('server.port', 8080)
    await refresh()

    // The refresh is over; the listener is not. What a feature does about new configuration is its own
    // business, and a slow reaction must not hold up the refresh or the features it has nothing to do with.
    expect(finished).toBe(false)

    const settled = configuration.settled()
    released?.()
    await settled

    expect(started).toHaveBeenCalledTimes(1)
    expect(finished).toBe(true)
  })

  it('never runs a listener concurrently with itself', async () => {
    const { slice, mutable, refresh, configuration } = await setup()
    let inFlight = 0
    let overlapped = false

    slice.onChange(async () => {
      inFlight++
      overlapped ||= inFlight > 1
      await new Promise(resolve => setTimeout(resolve, 5))
      inFlight--
    })

    mutable.set('server.port', 8080)
    await refresh()
    mutable.set('server.port', 9090)
    await refresh()

    await configuration.settled()

    // Overlapping deliveries could finish out of order and leave the *older* configuration applied.
    expect(overlapped).toBe(false)
  })

  it('collapses a burst into the newest value rather than a backlog', async () => {
    const { slice, mutable, refresh, configuration } = await setup()
    const seen: number[] = []
    let release: (() => void) | undefined
    const firstBlocked = new Promise<void>(resolve => {
      release = resolve
    })
    let first = true

    slice.onChange(async config => {
      seen.push((config as Server).port)
      if (first) {
        first = false
        await firstBlocked
      }
    })

    mutable.set('server.port', 1)
    await refresh()

    // Three more changes while the first delivery is stuck. Only the last one is worth telling anyone about.
    for (const port of [2, 3, 4]) {
      mutable.set('server.port', port)
      await refresh()
    }

    release?.()
    await configuration.settled()

    expect(seen).toEqual([1, 4])
  })

  it('gives a coalesced delivery the last value actually delivered as its previous', async () => {
    const { slice, mutable, refresh, configuration } = await setup()
    const seen: Array<[number, number]> = []
    let release: (() => void) | undefined
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })
    let first = true

    slice.onChange(async (config, previous) => {
      seen.push([(config as Server).port, (previous as Server).port])
      if (first) {
        first = false
        await blocked
      }
    })

    mutable.set('server.port', 1)
    await refresh()
    mutable.set('server.port', 2)
    await refresh()
    mutable.set('server.port', 3)
    await refresh()

    release?.()
    await configuration.settled()

    expect(seen).toEqual([
      [1, 3000],
      [3, 1],
    ])
  })
})

describe('onChange failures', () => {
  it('reports a throwing listener and keeps the others running', async () => {
    const warn = vi.fn()
    const { slice, mutable, refresh, configuration } = await setup(warn)
    const after = vi.fn()

    slice.onChange(() => {
      throw new Error('bad reaction')
    })
    slice.onChange(after)

    mutable.set('server.port', 8080)
    await refresh()
    await configuration.settled()

    expect(after).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatch(/server.*bad reaction/)
  })

  it('reports a rejecting listener rather than leaving an unhandled rejection', async () => {
    const warn = vi.fn()
    const { slice, mutable, refresh, configuration } = await setup(warn)

    slice.onChange(() => Promise.reject(new Error('async trouble')))

    mutable.set('server.port', 8080)
    await refresh()
    await configuration.settled()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatch(/async trouble/)
  })

  it('keeps delivering to a listener that failed once', async () => {
    const warn = vi.fn()
    const { slice, mutable, refresh, configuration } = await setup(warn)
    const seen: number[] = []

    slice.onChange(config => {
      seen.push((config as Server).port)
      if (seen.length === 1) {
        throw new Error('first one went badly')
      }
    })

    mutable.set('server.port', 8080)
    await refresh()
    await configuration.settled()

    mutable.set('server.port', 9090)
    await refresh()
    await configuration.settled()

    expect(seen).toEqual([8080, 9090])
  })
})

describe('Configuration.onChange', () => {
  it('fires on a change anywhere in the tree', async () => {
    const { configuration, mutable, refresh } = await setup()
    const seen: Array<[App, App]> = []

    configuration.onChange((config, previous) => {
      seen.push([config, previous])
    })

    mutable.set('server.port', 8080)
    await refresh()
    await configuration.settled()

    expect(seen).toHaveLength(1)
    expect(seen[0][0].server.port).toBe(8080)
    expect(seen[0][1].server.port).toBe(3000)
  })

  it('does not fire on a refresh with nothing to reload', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    definition.codeValues.set('server.port', 3000)
    definition.schema = schema

    const container = new CaffeineIoC({ decorators: false })
    container.addModules(ConfigModule(definition))
    await container.init()

    const configuration = container.get<Configuration<App>>(kConfiguration)
    const seen = vi.fn()
    configuration.onChange(seen)

    // The refresh gate returns before anything is resolved, so nothing is even published to compare.
    await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)
    await configuration.settled()

    expect(seen).not.toHaveBeenCalled()
  })
})
