import { CaffeineIoC, token } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import type { ConstraintStrategy } from '../../../core/constraints/constraints.js'
import { Router } from '../../../core/routing/programmatic/programmatic.js'
import { constraint } from '../../../decorators/constraint.js'
import { createWebApplication } from '../application.js'
import { constraints } from './constraints.js'

function tenantStrategy(): ConstraintStrategy {
  return {
    name: 'tenant',
    mustMatchWhenDerived: true,
    storage() {
      const map = new Map<string, unknown>()
      return {
        get: value => map.get(value) ?? null,
        set: (value, handler) => void map.set(value, handler),
      }
    },
    deriveConstraint: req => (req.headers['x-tenant'] as string | undefined) || undefined,
  }
}

describe('constraints()', () => {
  // What the callback buys: a strategy can be built by the container, with whatever it depends on, instead of
  // being constructed by hand where the application is assembled.
  it('registers the strategies the callback resolves out of the container', async () => {
    const kTenant = token<ConstraintStrategy>(Symbol('tenant-strategy'))
    const container = new CaffeineIoC()
    container.bind(kTenant, t => t.toValue(tenantStrategy()))
    const router = new Router('/home')
    router
      .get('/')
      .extend(constraint('tenant', 'acme', { header: 'X-Tenant' }))
      .handler(() => ({ tenant: 'acme' }))
    const app = createWebApplication({ container })
      .with(constraints(({ container }) => [container.get(kTenant)]))
      .mount(router)

    await app.bootstrap()

    expect(await (await app.request('/home', { headers: { 'x-tenant': 'acme' } })).json()).toEqual({ tenant: 'acme' })
    expect((await app.request('/home', { headers: { 'x-tenant': 'other' } })).status).toBe(404)

    await app.close()
  })
})
