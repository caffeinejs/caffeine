import { describe, it, expect } from 'vitest'

import { Controller, Get, Post, Status, createWebApplication } from '../index.js'

describe('Status', () => {
  it('returns the custom status code set by @Status', async () => {
    @Controller('/status')
    class StatusController {
      @Status(201)
      @Post('/created')
      create() {
        return { ok: true }
      }
    }

    void [StatusController]

    const app = createWebApplication()
    await app.ready()

    const res = await app.fetch('/status/created', { method: 'POST' })

    expect(res.status).toBe(201)
  })

  it('leaves status code to Fastify when @Status is not set', async () => {
    @Controller('/status-default')
    class StatusDefaultController {
      @Get('/ok')
      get() {
        return { ok: true }
      }
    }

    void [StatusDefaultController]

    const app = createWebApplication()
    await app.ready()

    const res = await app.fetch('/status-default/ok')

    expect(res.status).toBe(200)
  })

  it('completes an empty body when @Status is set and the handler returns void', async () => {
    @Controller('/status-empty')
    class StatusEmptyController {
      @Status(200)
      @Get('/ok')
      get() {}
    }

    void [StatusEmptyController]

    const app = createWebApplication()
    await app.ready()

    const res = await app.fetch('/status-empty/ok')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })
})
