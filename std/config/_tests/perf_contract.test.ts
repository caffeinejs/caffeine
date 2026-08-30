import { CaffeineIoC, token } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'
import { $t } from '../../schema/t.js'
import { createLiveAccessors } from '../accessor.js'
import { ConfigDefinition } from '../definition.js'
import { ConfigPriority } from '../sources.js'
import { CONFIG_REFRESH_LABEL, ConfigModule } from '../integration/module.js'
import { MutableConfigProvider } from '../providers/mutable_provider.js'

const APP_CONFIG = token<any>(Symbol('app.config'))

interface Slice { paths: { live: string }, port: number }

const schema = $t.Object({
  paths: $t.Object({ live: $t.String({ default: '/livez' }) }, { default: {} }),
  port: $t.Number({ default: 0 }),
})

async function containerFor(definition: ConfigDefinition): Promise<CaffeineIoC> {
  const container = new CaffeineIoC({ decorators: false })
  container.addModules(ConfigModule(definition))
  await container.init()
  return container
}

/**
 * The read-cost contract.
 *
 * Configuration is read on request paths, so a read has to be a property access on a plain object — never a
 * walk that allocates as it goes. These tests pin the behaviour rather than describing it, so nobody
 * reintroduces a per-read copy by accident.
 */
describe('config read cost', () => {
  it('keeps one identity while the fields follow a refresh', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    const mutable = new MutableConfigProvider('test')
    mutable.set('port', 3000)
    definition.sources.add(mutable, ConfigPriority.ENV)

    const slice = definition.slice<Slice>([], schema)
    const container = await containerFor(definition)

    const config = slice.config
    expect(config.port).toBe(3000)

    mutable.set('port', 8080)
    await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    // The same object a collaborator would be holding, now reporting the refreshed value. This is the whole
    // point: handing configuration to something that keeps it on a field must not hand it a stale copy.
    expect(slice.config).toBe(config)
    expect(config.port).toBe(8080)
  })

  it('allocates nothing on repeated reads', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    const slice = definition.slice<Slice>([], schema)
    await containerFor(definition)

    expect(slice.config).toBe(slice.config)
    expect(slice.config.paths).toBe(slice.config.paths)
  })

  it('hands back a merged-in value untouched, identity included', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    const slice = definition.slice<Slice>([], schema)
    await containerFor(definition)

    const dispatcher = { warn: () => undefined }
    const derived = slice.derive(config => ({ port: config.port, dispatcher }))

    // Not everything in a feature's options came from the config tree; what did not must survive unwrapped.
    expect(derived.config.dispatcher).toBe(dispatcher)
  })

  it('detaches a snapshot from later refreshes', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    const mutable = new MutableConfigProvider('test')
    mutable.set('port', 3000)
    definition.sources.add(mutable, ConfigPriority.ENV)

    const slice = definition.slice<Slice>([], schema)
    const container = await containerFor(definition)

    const taken = slice.snapshot()
    expect(taken.port).toBe(3000)

    mutable.set('port', 8080)
    await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    expect(taken.port).toBe(3000)
    expect(slice.config.port).toBe(8080)
    expect(slice.snapshot().port).toBe(8080)
  })

  it('freezes what it publishes', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    const slice = definition.slice<Slice>([], schema)
    await containerFor(definition)

    expect(Object.isFrozen(slice.snapshot())).toBe(true)
    expect(() => {
      (slice.config.paths as { live: string }).live = 'nope'
    }).toThrow(TypeError)
  })

  it('resolves a feature namespace once, not on every read', () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    const slice = definition.slice<Slice>(['app', 'server'], schema)

    // Pre-split at registration: a lookup walks segments, it never parses a dotted key.
    expect(slice.parts).toEqual(['app', 'server'])
  })

  it('memoises the application handle against the resolve revision', () => {
    let data = { http: { host: 'old' } }
    let revision = 0
    const handle = createLiveAccessors(() => data, () => revision)

    const http = handle.http
    expect(http.host).toBe('old')
    // Nested nodes are built once and kept, so a read after the first touch constructs nothing.
    expect(handle.http).toBe(http)

    data = { http: { host: 'new' } }
    revision++

    expect(handle.http).toBe(http)
    expect(handle.http.host).toBe('new')
  })

  it('reads straight through when no revision is supplied', () => {
    let data = { http: { host: 'old' } }
    const handle = createLiveAccessors(() => data)

    expect(handle.http.host).toBe('old')
    data = { http: { host: 'new' } }
    expect(handle.http.host).toBe('new')
  })

  it('notifies nobody when a refresh had nothing to reload', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    definition.codeValues.set(['app', 'server', 'port'], 3000)
    const slice = definition.slice<Slice>(['app', 'server'], schema)

    const container = await containerFor(definition)

    let called = false
    slice.onChange(() => {
      called = true
    })

    // The gate returns before anything resolves, so nothing is published and there is nothing to compare — a
    // listener costs nothing on a refresh that could not have changed anything.
    await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)
    await slice.settled()

    expect(called).toBe(false)
  })

  it('compares nothing while nobody is listening', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    const mutable = new MutableConfigProvider('test')
    mutable.set('app.server.port', 3000)
    definition.sources.add(mutable, ConfigPriority.ENV)
    const slice = definition.slice<Slice>(['app', 'server'], schema)

    const container = await containerFor(definition)

    mutable.set('app.server.port', 8080)
    await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    // The value moved with nobody watching, and a listener registering now hears about what happens next
    // rather than being handed a change that predates it.
    let called = false
    slice.onChange(() => {
      called = true
    })

    mutable.set('app.server.port', 8080)
    await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)
    await slice.settled()

    expect(slice.config.port).toBe(8080)
    expect(called).toBe(false)
  })
})
