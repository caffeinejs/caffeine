import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createApplication } from './application_builder.js'
import { InlineConfigProvider } from './config/index.js'
import { type Service } from './service.js'
import type { Plugin } from './plugin.js'

// A sentinel the plugin's service binds, so a test can prove `.extend()` rides the same
// `configure()` path a built-in service does rather than merely copying methods onto the builder.
const kSentinel = Symbol('extend-sentinel')

function tracker<const Name extends string = 'track'>(
  name: Name = 'track' as Name,
): Plugin<Record<Name, (value: string) => void>> {
  const state: { value: string | undefined } = { value: undefined }
  const service: Service = {
    get name() {
      return 'track'
    },
    bootstrap(kit) {
      kit.container.bind(kSentinel).toValue({ value: state.value })
      return Promise.resolve()
    },
  }

  return {
    name,
    install(ctx) {
      ctx.addService(service)

      const capture = (value: string): void => {
        state.value = value
      }

      return { [name]: capture } as Record<Name, (value: string) => void>
    },
  }
}

describe('BaseApplicationBuilder.extend', () => {
  it('installs the plugin method and registers its service', async () => {
    const builder = createApplication().extend(tracker())

    expect(typeof builder.track).toBe('function')
    builder.track('recorded')

    const app = builder.build()
    await app.ready()

    expect(app.container.getOptional(kSentinel)).toEqual({ value: 'recorded' })
    await app.close()
  })

  it('composes several plugins in one call', () => {
    const builder = createApplication().extend(tracker('a'), tracker('b'))

    expect(typeof builder.a).toBe('function')
    expect(typeof builder.b).toBe('function')
  })

  it('accumulates across separate calls', () => {
    const builder = createApplication()
      .extend(tracker('first'))
      .extend(tracker('second'))

    expect(typeof builder.first).toBe('function')
    expect(typeof builder.second).toBe('function')
  })

  it('returns the same builder instance it was called on', () => {
    const builder = createApplication()

    expect(builder.extend(tracker())).toBe(builder)
  })

  it('leaves a builder that was never extended unaugmented (type-level)', () => {
    const builder = createApplication()

    // @ts-expect-error no plugin contributed `track`
    const missing: unknown = builder.track
    expect(missing).toBeUndefined()
  })

  it('keeps the plugin methods across .config(), in either order', () => {
    const schema = z.object({ server: z.object({ port: z.coerce.number() }) })

    const afterConfig = createApplication()
      .extend(tracker())
      .config(schema, c => c.source(new InlineConfigProvider({ server: { port: 1 } })))

    const beforeConfig = createApplication()
      .config(schema, c => c.source(new InlineConfigProvider({ server: { port: 1 } })))
      .extend(tracker())

    // Declaring configuration re-parameterises the builder. It must not cost the plugin's methods along the
    // way, or the order of an otherwise commutative chain would start to matter.
    expect(typeof afterConfig.track).toBe('function')
    expect(typeof beforeConfig.track).toBe('function')
  })

  it('still refuses a plugin method nobody contributed, after .config() (type-level)', () => {
    const builder = createApplication()
      .config(z.object({}), c => c.source(new InlineConfigProvider({})))

    // @ts-expect-error no plugin contributed `track`
    const missing: unknown = builder.track
    expect(missing).toBeUndefined()
  })
})
