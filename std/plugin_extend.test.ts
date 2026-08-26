import { describe, it, expect } from 'vitest'
import { createApplication } from './application_builder.js'
import { kServiceConfigure, type Service } from './service.js'
import type { Plugin } from './plugin.js'

// A sentinel the plugin's service binds, so a test can prove `.extend()` rides the same
// `[kServiceConfigure]` path a built-in service does rather than merely copying methods onto the builder.
const kSentinel = Symbol('extend-sentinel')

function tracker<const Name extends string = 'track'>(
  name: Name = 'track' as Name,
): Plugin<Record<Name, (value: string) => void>> {
  const state: { value: string | undefined } = { value: undefined }
  const service: Service = {
    [kServiceConfigure](kit) {
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
})
