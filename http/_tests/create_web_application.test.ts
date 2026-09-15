import { CaffeineIoC, token } from '@caffeinejs/di'
import {
  ErrApplicationStarted,
  kFeatureBootstrap,
  kFeatureConfigure,
  kFeatureName,
  type Feature,
  type FeatureConfigureKit,
} from '@caffeinejs/std'
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

    const app = createWebApplication()
    await app.ready()

    const res = await app.fetch('/default-app/data')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('exposes a Fastify instance', async () => {
    const app = createWebApplication()
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
    const app = createWebApplication({ container })
    await app.ready()

    expect(app.container).toBe(container)

    const res = await app.fetch('/default-app-container/data')
    expect(await res.json()).toEqual({ via: 'container' })
  })

  it('accepts features after the options argument', async () => {
    const kProbe = token<Record<string, unknown>>(Symbol('probe-sentinel'))

    const state: { value: string | undefined } = { value: undefined }

    const probe: Feature = {
      [kFeatureName]: 'probe',
      [kFeatureConfigure](kit: FeatureConfigureKit) {
        state.value = 'hello'
        kit.container.bind(kProbe, t => t.toValue({ value: state.value }))
        return Promise.resolve()
      },
      [kFeatureBootstrap]() {
        return Promise.resolve()
      },
    }

    const app = createWebApplication().with(probe)
    await app.ready()

    expect(app.container.getOptional(kProbe)).toEqual({ value: 'hello' })
  })
})

describe('configuring a started web application', () => {
  // The HTTP-only methods are refused the same way the shared ones are: once `ready()` has read the feature
  // list, a server port or an authentication scheme written afterwards would never take effect.
  it('refuses server, authentication, guards, health and plugin configuration once ready() has run', async () => {
    const app = createWebApplication()
    await app.ready()

    expect(() => app.server(s => s.port(0))).toThrow(ErrApplicationStarted)
    expect(() => app.authentication(a => a.default('Bearer'))).toThrow(ErrApplicationStarted)
    expect(() => app.authorization(a => a.requireAuthenticatedByDefault())).toThrow(ErrApplicationStarted)
    expect(() => app.guards(() => undefined)).toThrow(ErrApplicationStarted)
    expect(() => app.health()).toThrow(ErrApplicationStarted)
    expect(() => app.with(() => async () => undefined)).toThrow(ErrApplicationStarted)
  })
})
