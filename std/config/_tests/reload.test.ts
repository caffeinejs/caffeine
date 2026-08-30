import { CaffeineIoC, token } from '@caffeinejs/di'
import { describe, expect, it, vi } from 'vitest'
import { $t } from '../../schema/t.js'
import { ConfigDefinition } from '../definition.js'
import { ConfigPriority } from '../sources.js'
import { Configuration, kConfiguration } from '../configuration.js'
import { CONFIG_REFRESH_LABEL, ConfigModule } from '../integration/module.js'
import { ArgsConfigProvider } from '../providers/args_provider.js'
import { EnvConfigProvider } from '../providers/env_provider.js'
import { InlineConfigProvider } from '../providers/inline_provider.js'
import { MutableConfigProvider } from '../providers/mutable_provider.js'
import type { ConfigProvider, PropertySource, ResolutionContext } from '../types.js'

const APP_CONFIG = token<any>(Symbol('app.config'))
const schema = $t.Object({ port: $t.Number({ default: 0 }) })

async function containerFor(definition: ConfigDefinition): Promise<CaffeineIoC> {
  const container = new CaffeineIoC({ decorators: false })
  container.addModules(ConfigModule(definition))
  await container.init()
  return container
}

const refresh = (container: CaffeineIoC): Promise<void> =>
  container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

/** Counts loads, so "did nothing" can be asserted rather than inferred. */
function counting(inner: ConfigProvider): ConfigProvider & { loads: number } {
  const spy = {
    id: inner.id,
    reloadable: inner.reloadable,
    revision: inner.revision?.bind(inner),
    loads: 0,
    load(ctx: ResolutionContext): Promise<PropertySource[]> {
      spy.loads++
      return inner.load(ctx)
    },
  }
  return spy
}

/**
 * A refresh that cannot possibly change anything must cost nothing.
 *
 * Most sources are fixed for the lifetime of a process — the environment it started with, the arguments it was
 * given, an inline object. Reloading all of that on a timer, re-validating every schema and replacing every
 * object so that identical values can be recomputed, is pure waste, and it invalidates every reference anything
 * was holding for no reason at all.
 */
describe('refresh gating', () => {
  it('does nothing at all when no source can reload', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    const env = counting(new EnvConfigProvider())
    const args = counting(new ArgsConfigProvider({ argv: ['--port=3000'] }))
    const inline = counting(new InlineConfigProvider({ port: 1 }))

    definition.sources.add(inline)
    definition.sources.add(env, ConfigPriority.ENV)
    definition.sources.add(args, ConfigPriority.ARGS)
    definition.schema = schema

    const container = await containerFor(definition)
    const configuration = container.get<Configuration<{ port: number }>>(kConfiguration)

    const loadsAfterBootstrap = env.loads + args.loads + inline.loads
    const before = configuration.snapshot()

    await refresh(container)

    expect(env.loads + args.loads + inline.loads).toBe(loadsAfterBootstrap)
    // Not merely equal — the very same object, so nothing holding a reference was disturbed.
    expect(configuration.snapshot()).toBe(before)
    expect(configuration.revision).toBe(0)
  })

  it('does nothing when a reloadable source reports an unchanged stamp', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    const mutable = new MutableConfigProvider('test')
    mutable.set('port', 3000)
    const counted = counting(mutable)
    definition.sources.add(counted, ConfigPriority.ENV)
    definition.schema = schema

    const container = await containerFor(definition)
    const loads = counted.loads

    await refresh(container)

    expect(counted.loads).toBe(loads)
    expect(container.get<Configuration<unknown>>(kConfiguration).revision).toBe(0)
  })

  it('reloads once a mutable source has actually been written to', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    const mutable = new MutableConfigProvider('test')
    mutable.set('port', 3000)
    definition.sources.add(mutable, ConfigPriority.ENV)
    definition.schema = schema

    const container = await containerFor(definition)
    const configuration = container.get<Configuration<{ port: number }>>(kConfiguration)

    mutable.set('port', 8080)
    await refresh(container)

    expect(configuration.snapshot().port).toBe(8080)
    expect(configuration.revision).toBe(1)
  })

  it('always reloads a source that cannot report a stamp', async () => {
    let port = 3000
    const remote = counting({
      id: 'remote',
      reloadable: true,
      load: ctx => new InlineConfigProvider({ port }).load(ctx),
    })

    const definition = new ConfigDefinition(APP_CONFIG)
    definition.sources.add(remote, ConfigPriority.ENV)
    definition.schema = schema

    const container = await containerFor(definition)
    const loads = remote.loads

    port = 8080
    await refresh(container)

    // Knowing whether a config server changed means asking it, which is the same call as reloading.
    expect(remote.loads).toBe(loads + 1)
    expect(container.get<Configuration<{ port: number }>>(kConfiguration).snapshot().port).toBe(8080)
  })

  it('treats a source registered after bootstrap as a change in its own right', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    definition.sources.add(new InlineConfigProvider({ port: 1 }))
    definition.schema = schema

    const container = await containerFor(definition)
    const configuration = container.get<Configuration<{ port: number }>>(kConfiguration)

    // Neither the old source nor the new one can reload, but the registry itself changed.
    definition.sources.add(new InlineConfigProvider({ port: 2 }), ConfigPriority.ENV)
    await refresh(container)

    expect(configuration.snapshot().port).toBe(2)
    expect(configuration.revision).toBe(1)
  })

  it('leaves the framework bands from defeating the gate', async () => {
    // Every application registers two mutable sources for its own bands, so "is anything reloadable" is always
    // true. The stamp tier is what makes the gate mean something.
    const definition = new ConfigDefinition(APP_CONFIG)
    definition.frameworkDefaults.set('port', 0)
    definition.codeValues.set('port', 3000)
    definition.schema = schema

    const container = await containerFor(definition)
    const configuration = container.get<Configuration<unknown>>(kConfiguration)

    await refresh(container)
    await refresh(container)

    expect(configuration.revision).toBe(0)
  })

  it('reloads when a framework band is written to at runtime', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    definition.codeValues.set('port', 3000)
    definition.schema = schema

    const container = await containerFor(definition)
    const configuration = container.get<Configuration<{ port: number }>>(kConfiguration)

    definition.codeValues.set('port', 8080)
    await refresh(container)

    expect(configuration.snapshot().port).toBe(8080)
  })

  it('does not warn when there was nothing to report', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    definition.warn = vi.fn()
    definition.sources.add(new InlineConfigProvider({ port: 1 }))
    definition.schema = schema

    const container = await containerFor(definition)
    await refresh(container)

    expect(definition.warn).not.toHaveBeenCalled()
  })
})
