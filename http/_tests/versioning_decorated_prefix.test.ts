import { CaffeineIoC } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import { Controller, Get, Prefix, createWebApplication } from '../index.js'

/**
 * Kept in its own file: `@Controller` registers into a module-global registry that every later
 * `new CaffeineIoC()` snapshots, so sharing a file with `@Version`-constrained controllers
 * (`versioning_decorated.test.ts`) would trip the constraints-plugin startup check for a route
 * group that carries no constraint of its own.
 */
describe('API versioning — decorated controllers', () => {
  it('@Prefix is URI versioning and stays unconstrained — /v1/pets answers with no Accept-Version', async () => {
    @Prefix('/v1')
    @Controller('/pets')
    class V1Pets {
      @Get('/')
      list() {
        return { prefixed: true }
      }
    }

    const container = new CaffeineIoC()
    container.bind(V1Pets, t => t.toSelf())
    const app = createWebApplication({ container })
    await app.ready()

    expect(await (await app.fetch('/v1/pets')).json()).toEqual({ prefixed: true })

    await app.close()
  })
})
