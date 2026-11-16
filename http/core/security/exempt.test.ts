import { describe, expect, it } from 'vitest'

import type { HTTPSetupContext } from '../../adapter.js'
import { createWebApplication } from '../../application.js'
import { HTTPPlugin } from '../../plugin.js'
import { Router } from '../routing/programmatic/programmatic.js'
import { ACCESS_CONTROL_EXEMPT, accessControlExempt, isAccessControlExempt, kAccessControlExempt } from './exempt.js'

// Only the framework's own value marks a route: a config an application writes in code cannot drop its access control.
describe('isAccessControlExempt', () => {
  it('is true for the framework mark', () => {
    expect(isAccessControlExempt(new Map([[kAccessControlExempt, ACCESS_CONTROL_EXEMPT]]))).toBe(true)
  })

  it('is false for a value an application could write under the same key', () => {
    expect(isAccessControlExempt(new Map([[kAccessControlExempt, true]]))).toBe(false)
  })

  it('is false for a route that carries no mark', () => {
    expect(isAccessControlExempt(new Map())).toBe(false)
  })
})

describe('accessControlExempt', () => {
  it('marks every route of a router with the framework value', async () => {
    const seen: boolean[] = []
    const app = createWebApplication()
      .with(
        () =>
          new (class extends HTTPPlugin {
            register({ app }: HTTPSetupContext): void {
              app.hook('onRoute', route => {
                seen.push(isAccessControlExempt(route.config))
              })
            }
          })(),
      )
      .mount(
        new Router('/x')
          .extend(accessControlExempt())
          .get('/')
          .handler(() => 'ok'),
      )

    try {
      await app.bootstrap()
    } finally {
      await app.close()
    }

    expect(seen).toEqual([true])
  })
})
