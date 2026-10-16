import { describe, expect, it } from 'vitest'

import { Controller, Get, HTTPPlugin, type HTTPSetupContext, Router, Use } from '../index.js'
import { createWebApplication } from '../platform/fastify/index.js'

/**
 * Scenario: a controller's plugin trying to mount. A class has no children to nest routers under, so the start is
 * refused. In a file of its own: every application built here picks up this class, and none of them can start.
 */

class Mounting extends HTTPPlugin {
  register({ app }: HTTPSetupContext): void {
    app.mount(new Router('/x').get('/', () => ({})))
  }
}

@Use(() => new Mounting())
@Controller('/mounting')
class MountingController {
  @Get('/')
  get() {
    return {}
  }
}

void MountingController

describe('HTTPPlugin on a controller, mounting', () => {
  it("refuses app.mount from a controller's plugin", async () => {
    const app = createWebApplication()

    await expect(app.bootstrap()).rejects.toThrow(/^Cannot call "app\.mount" from a controller's plugin/)
  })
})
