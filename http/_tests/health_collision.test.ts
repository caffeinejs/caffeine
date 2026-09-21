import { describe, it, expect } from 'vitest'

import { health } from '../health/health.js'
import { Controller, Get, createWebApplication } from '../index.js'

// Isolated in its own file: the container snapshots the controller registry when it is constructed, so the
// colliding controller below would otherwise be picked up by every application built after this test runs.
describe('health probe path collisions', () => {
  it('refuses to start when a route already owns a probe path', async () => {
    @Controller('/')
    class CollidingController {
      @Get('/readyz')
      readyz() {
        return {}
      }
    }

    void [CollidingController]

    const app = createWebApplication().with(health())

    await expect(app.ready()).rejects.toThrow(/already registered at "\/readyz"/)
  })
})
