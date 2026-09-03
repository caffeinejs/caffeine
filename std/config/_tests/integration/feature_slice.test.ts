import { CaffeineIoC, token, opaqueToken } from '@caffeinejs/di'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { $t } from '../../../schema/t.js'
import { Configuration, kConfiguration } from '../../configuration.js'
import { ConfigDefinition } from '../../definition.js'
import { ErrConfigSlices, ErrConfigValidation } from '../../errors.js'
import { CONFIG_REFRESH_LABEL, ConfigModule } from '../../integration/module.js'
import { InlineConfigProvider } from '../../providers/inline_provider.js'
import { MutableConfigProvider } from '../../providers/mutable_provider.js'
import { ConfigPriority } from '../../sources.js'

const APP_CONFIG = opaqueToken(Symbol('app.config'))

interface ServerSlice {
  port: number
  host: string
}

const serverSlice = $t.Object({
  port: $t.Number({ default: 0 }),
  host: $t.String({ default: '0.0.0.0' }),
})

async function containerFor(definition: ConfigDefinition): Promise<CaffeineIoC> {
  const container = new CaffeineIoC({ decorators: false })
  container.addModules(ConfigModule(definition))
  await container.init()
  return container
}

describe('feature slices', () => {
  it('validates from the materialized tree even when the root schema drops the namespace', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    // The application describes only `db` — under a stripping schema (zod and TypeBox both drop undeclared
    // keys) the `server` namespace would never reach the feature if slices read the validated root.
    definition.schema = z.object({ db: z.object({ url: z.string() }) })
    definition.sources.add(
      new InlineConfigProvider({
        db: { url: 'postgres://x' },
        server: { port: 8080, host: '127.0.0.1' },
      }),
    )

    const slice = definition.slice<ServerSlice>(['server'], serverSlice)
    await containerFor(definition)

    expect(slice.config).toEqual({ port: 8080, host: '127.0.0.1' })
  })

  it('resolves a slice at a nested namespace', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    definition.sources.add(new InlineConfigProvider({ app: { server: { port: 9000, host: '::1' } } }))

    const slice = definition.slice<ServerSlice>(['app', 'server'], serverSlice)
    await containerFor(definition)

    expect(slice.config).toEqual({ port: 9000, host: '::1' })
  })

  it('falls back to the schema defaults when the namespace holds nothing', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    const slice = definition.slice<ServerSlice>(['server'], serverSlice)

    await containerFor(definition)

    expect(slice.config).toEqual({ port: 0, host: '0.0.0.0' })
  })

  it('layers the code band under a higher-priority source within one slice', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    definition.codeValues.set(['server', 'port'], 3000)
    definition.codeValues.set(['server', 'host'], '127.0.0.1')
    definition.sources.add(new InlineConfigProvider({ server: { port: 8080 } }), ConfigPriority.ENV)

    const slice = definition.slice<ServerSlice>(['server'], serverSlice)
    await containerFor(definition)

    expect(slice.config).toEqual({ port: 8080, host: '127.0.0.1' })
  })

  it('republishes the slice on a refresh', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    const mutable = new MutableConfigProvider('test')
    mutable.set('server.port', 3000)
    definition.sources.add(mutable, ConfigPriority.ENV)

    const slice = definition.slice<ServerSlice>(['server'], serverSlice)
    const container = await containerFor(definition)

    expect(slice.config.port).toBe(3000)

    mutable.set('server.port', 8080)
    await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    expect(slice.config.port).toBe(8080)
  })

  it('picks up a source registered after bootstrap on the next refresh', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    definition.codeValues.set(['server', 'port'], 3000)

    const slice = definition.slice<ServerSlice>(['server'], serverSlice)
    const container = await containerFor(definition)

    expect(slice.config.port).toBe(3000)

    definition.sources.add(new InlineConfigProvider({ server: { port: 8080 } }), ConfigPriority.ENV)
    await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    expect(slice.config.port).toBe(8080)
  })

  it('fails start-up when a slice cannot validate, naming the feature', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    definition.sources.add(new InlineConfigProvider({ server: { port: 'not-a-port', host: 1 } }))
    definition.slice<ServerSlice>(['server'], $t.Object({ port: $t.Number(), host: $t.String() }))

    // Isolation is what a refresh needs. A process that cannot configure a feature at all should say so and
    // stop, rather than come up and fail whenever that feature is first used.
    const error = await containerFor(definition).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ErrConfigSlices)
    expect((error as ErrConfigSlices).failures.map(f => f.path)).toEqual(['server'])
    expect((error as ErrConfigSlices).failures[0].error).toBeInstanceOf(ErrConfigValidation)
  })

  it('refuses to be read before configuration resolves', () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    const slice = definition.slice<ServerSlice>(['server'], serverSlice)

    expect(slice.published).toBe(false)
    expect(() => slice.config).toThrow(/has not been resolved yet/)
  })

  it('freezes the published value so a feature cannot mutate shared configuration', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    definition.sources.add(new InlineConfigProvider({ server: { port: 8080, host: 'h' } }))

    const slice = definition.slice<ServerSlice>(['server'], serverSlice)
    await containerFor(definition)

    // The published values are frozen; the config object reading through to them exposes getters only, so
    // either route to a write fails.
    expect(Object.isFrozen(slice.snapshot())).toBe(true)
    expect(() => {
      ;(slice.config as { port: number }).port = 1
    }).toThrow(TypeError)
  })

  it('recomputes a derived view on every publish', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    const mutable = new MutableConfigProvider('test')
    mutable.set('server.port', 3000)
    definition.sources.add(mutable, ConfigPriority.ENV)

    const slice = definition.slice<ServerSlice>(['server'], serverSlice)
    const view = slice.derive(value => `${value.host}:${value.port}`)

    const container = await containerFor(definition)
    expect(view.config).toBe('0.0.0.0:3000')

    mutable.set('server.port', 8080)
    await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    expect(view.config).toBe('0.0.0.0:8080')
  })

  it('derives from an already-published slice', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    definition.sources.add(new InlineConfigProvider({ server: { port: 8080, host: 'h' } }))

    const slice = definition.slice<ServerSlice>(['server'], serverSlice)
    await containerFor(definition)

    // Registered after the bootstrap — it still has a value, rather than waiting for the next refresh.
    expect(slice.derive(value => value.port).config).toBe(8080)
  })

  it('isolates a failing refresh to its own feature', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    const warnings: string[] = []
    definition.warn = message => warnings.push(message)

    const mutable = new MutableConfigProvider('test')
    mutable.set('server.port', 3000)
    mutable.set('other.port', 1)
    definition.sources.add(mutable, ConfigPriority.ENV)

    const server = definition.slice<ServerSlice>(
      ['server'],
      $t.Object({
        port: $t.Number({ maximum: 5000 }),
        host: $t.String({ default: '0.0.0.0' }),
      }),
    )
    const other = definition.slice<{ port: number }>(['other'], $t.Object({ port: $t.Number() }))

    const container = await containerFor(definition)
    expect(server.config.port).toBe(3000)

    mutable.set('server.port', 8080)
    mutable.set('other.port', 2)
    // Resolves: one feature's bad value must not take configuration down for everything else.
    await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    expect(other.config.port).toBe(2)
    // The failing feature keeps the last values that did validate, rather than a half-updated object.
    expect(server.config.port).toBe(3000)
    expect(server.error).toBeInstanceOf(ErrConfigValidation)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/server/)
  })

  it('contains a throwing derivation exactly like a failing validation', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    const mutable = new MutableConfigProvider('test')
    mutable.set('server.port', 3000)
    definition.sources.add(mutable, ConfigPriority.ENV)

    const slice = definition.slice<ServerSlice>(['server'], serverSlice)
    const derived = slice.derive(value => {
      if (value.port > 5000) {
        throw new Error('port out of range')
      }
      return value.port
    })

    const container = await containerFor(definition)

    mutable.set('server.port', 8080)
    await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    // A derivation can reject a combination that validates field by field; it is caught by the same guard.
    expect(slice.error).toBeInstanceOf(Error)
    expect(derived.config).toBe(3000)
  })

  it('records a failed refresh in the diagnostics', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    const mutable = new MutableConfigProvider('test')
    mutable.set('server.port', 3000)
    definition.sources.add(mutable, ConfigPriority.ENV)

    definition.slice<ServerSlice>(
      ['server'],
      $t.Object({
        port: $t.Number({ maximum: 5000 }),
        host: $t.String({ default: '0.0.0.0' }),
      }),
    )

    const container = await containerFor(definition)
    const configuration = container.get<Configuration<unknown>>(kConfiguration)

    expect(configuration.diagnostics.sliceErrors).toEqual([])

    mutable.set('server.port', 8080)
    await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    expect(configuration.diagnostics.sliceErrors.map(e => e.path)).toEqual(['server'])
  })

  it('refuses to read a derived view before configuration resolves', () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    const view = definition.slice<ServerSlice>(['server'], serverSlice).derive(value => value.port)

    expect(() => view.config).toThrow(/has not been resolved yet/)
  })

  it('publishes every slice before any change listener runs', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    const mutable = new MutableConfigProvider('test')
    mutable.set('server.port', 3000)
    mutable.set('other.port', 1)
    definition.sources.add(mutable, ConfigPriority.ENV)

    const server = definition.slice<ServerSlice>(['server'], serverSlice)
    const other = definition.slice<{ port: number }>(['other'], $t.Object({ port: $t.Number({ default: 0 }) }))

    const container = await containerFor(definition)

    let otherSeenFromServer: number | undefined
    server.onChange(() => {
      // The listener that runs first must not find a feature it has nothing to do with still holding its
      // previous values. Notification is a separate phase from publishing precisely so this cannot happen.
      otherSeenFromServer = other.config.port
    })

    mutable.set('server.port', 8080)
    mutable.set('other.port', 2)
    await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)
    await container.get<Configuration<unknown>>(kConfiguration).settled()

    expect(otherSeenFromServer).toBe(2)
  })

  it('notifies a derived slice with the derived value', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    const mutable = new MutableConfigProvider('test')
    mutable.set('server.port', 3000)
    definition.sources.add(mutable, ConfigPriority.ENV)

    const slice = definition.slice<ServerSlice>(['server'], serverSlice)
    // A feature holds the derived slice rather than the raw one — health does exactly this — so the notify pass
    // has to reach it too.
    const view = slice.derive(value => `${value.host}:${value.port}`)

    const container = await containerFor(definition)

    const seen: Array<[string, string]> = []
    view.onChange((config, previous) => {
      seen.push([config, previous])
    })

    mutable.set('server.port', 8080)
    await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)
    await container.get<Configuration<unknown>>(kConfiguration).settled()

    expect(seen).toEqual([['0.0.0.0:8080', '0.0.0.0:3000']])
  })

  it('notifies nobody for a slice whose refresh failed', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    definition.warn = () => undefined

    const mutable = new MutableConfigProvider('test')
    mutable.set('server.port', 3000)
    mutable.set('other.port', 1)
    definition.sources.add(mutable, ConfigPriority.ENV)

    const server = definition.slice<ServerSlice>(
      ['server'],
      $t.Object({
        port: $t.Number({ maximum: 5000 }),
        host: $t.String({ default: '0.0.0.0' }),
      }),
    )
    const other = definition.slice<{ port: number }>(['other'], $t.Object({ port: $t.Number({ default: 0 }) }))

    const container = await containerFor(definition)

    const serverSeen = vi.fn()
    const otherSeen = vi.fn()
    server.onChange(serverSeen)
    other.onChange(otherSeen)

    mutable.set('server.port', 8080)
    mutable.set('other.port', 2)
    await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)
    await container.get<Configuration<unknown>>(kConfiguration).settled()

    // A failed slice keeps its last good values, so nothing about it changed. The feature that did refresh
    // hears about it as usual.
    expect(serverSeen).not.toHaveBeenCalled()
    expect(otherSeen).toHaveBeenCalledTimes(1)
  })

  it('binds the root config with a passthrough schema when none was declared', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    definition.sources.add(new InlineConfigProvider({ anything: { at: 'all' } }))

    const container = await containerFor(definition)

    expect(container.get<{ anything: { at: string } }>(APP_CONFIG).anything.at).toBe('all')
  })
})
