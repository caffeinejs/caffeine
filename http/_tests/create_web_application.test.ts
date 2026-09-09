import { CaffeineIoC, token } from '@caffeinejs/di'
import { feature, kBootstrap, kFeatureName, type BootstrapKit } from '@caffeinejs/std'
import { describe, it, expect } from 'vitest'

import { Controller, Get, createWebApplication } from '../index.js'

describe('createWebApplication default Fastify form', () => {
  it('builds a working app with no adapter factory or Fastify instance', async () => {
    @Controller('/default-app')
    class DefaultAppController {
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [DefaultAppController]

    const app = createWebApplication().build()
    await app.ready()

    const res = await app.fetch('/default-app/data')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('exposes a Fastify instance', async () => {
    const app = createWebApplication().build()
    await app.ready()

    expect(typeof (app.instance as { inject?: unknown }).inject).toBe('function')
  })

  it('uses a container supplied through options', async () => {
    @Controller('/default-app-container')
    class DefaultContainerController {
      @Get('/data')
      data() {
        return { via: 'container' }
      }
    }
    void [DefaultContainerController]

    const container = new CaffeineIoC()
    const app = createWebApplication({ container }).build()
    await app.ready()

    expect(app.container).toBe(container)

    const res = await app.fetch('/default-app-container/data')
    expect(await res.json()).toEqual({ via: 'container' })
  })

  it('accepts features after the options argument', async () => {
    const kProbe = token<Record<string, unknown>>(Symbol('probe-sentinel'))

    const probe = feature('probe', () => {
      const state: { value: string | undefined } = { value: undefined }
      return {
        [kFeatureName]: 'probe',
        capture(value: string) {
          state.value = value
        },
        [kBootstrap](kit: BootstrapKit) {
          kit.container.bind(kProbe, t => t.toValue({ value: state.value }))
          return Promise.resolve()
        },
      }
    })

    const app = createWebApplication().extend(probe, t => t.capture('hello'))

    const built = app.build()
    await built.ready()

    expect(built.container.getOptional(kProbe)).toEqual({ value: 'hello' })
  })
})
