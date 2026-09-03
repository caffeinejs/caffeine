import { describe, it, expect } from 'vitest'
import { token } from '@caffeinejs/di'
import { z } from 'zod'
import { createApplication } from './application_builder.js'
import { InlineConfigProvider } from './config/index.js'
import { type Service } from './service.js'
import { defineFeature, defineKeyedFeature, ErrFeatureAlreadyInstalled } from './plugin.js'

const kSentinel = token<any>(Symbol('extend-sentinel'))

function tracker(name = 'track') {
  return defineFeature<{ capture(value: string): void }>({
    name,
    singleton: true,
    install(ctx, configure) {
      const state: { value: string | undefined } = { value: undefined }
      const service: Service = {
        get name() {
          return 'track'
        },
        bootstrap(kit) {
          kit.container.bind(kSentinel, t => t.toValue({ value: state.value }))
          return Promise.resolve()
        },
      }
      ctx.addService(service)
      configure?.({
        capture(value: string) {
          state.value = value
        },
      })
    },
  })
}

describe('BaseApplicationBuilder.extend', () => {
  it('installs the feature and registers its service', async () => {
    const builder = createApplication().extend(tracker(), t => t.capture('recorded'))

    const app = builder.build()
    await app.ready()

    expect(app.container.getOptional(kSentinel)).toEqual({ value: 'recorded' })
    await app.close()
  })

  it('returns the same builder instance it was called on', () => {
    const builder = createApplication()

    expect(builder.extend(tracker())).toBe(builder)
  })

  it('does not add methods to the builder', () => {
    const builder = createApplication().extend(tracker())

    // @ts-expect-error features no longer contribute methods
    const missing: unknown = builder.track
    expect(missing).toBeUndefined()
  })

  it('keeps .extend available across .config(), in either order', () => {
    const schema = z.object({ server: z.object({ port: z.coerce.number() }) })

    const afterConfig = createApplication()
      .extend(tracker())
      .config(schema, c => c.source(new InlineConfigProvider({ server: { port: 1 } })))

    const beforeConfig = createApplication()
      .config(schema, c => c.source(new InlineConfigProvider({ server: { port: 1 } })))
      .extend(tracker())

    expect(typeof afterConfig.extend).toBe('function')
    expect(typeof beforeConfig.extend).toBe('function')
  })

  it('throws when a singleton feature is installed twice', () => {
    const feature = tracker()

    expect(() => createApplication().extend(feature).extend(feature)).toThrow(ErrFeatureAlreadyInstalled)
  })

  it('throws when a keyed instance is installed twice', () => {
    const feature = defineKeyedFeature({
      name: 'keyed',
      defaultInstance: 'default',
      install(ctx) {
        ctx.addService({
          get name() {
            return 'keyed'
          },
          bootstrap() {
            return Promise.resolve()
          },
        })
      },
    })

    expect(() => createApplication().extend(feature).extend(feature)).toThrow(ErrFeatureAlreadyInstalled)
    expect(() => createApplication().extend(feature('orders')).extend(feature('orders')))
      .toThrow(ErrFeatureAlreadyInstalled)
  })

  it('allows distinct keyed instances', () => {
    const feature = defineKeyedFeature({
      name: 'keyed',
      defaultInstance: 'default',
      install(ctx) {
        ctx.addService({
          get name() {
            return 'keyed'
          },
          bootstrap() {
            return Promise.resolve()
          },
        })
      },
    })

    const builder = createApplication().extend(feature).extend(feature('orders'))
    expect(builder).toBeDefined()
  })
})
