import { describe, it, expect } from 'vitest'

import { createWebApplication } from '../application.js'
import { Controller, Get, Post, Status } from '../index.js'
import { node } from '../platform/node.testkit.js'

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

    const app = createWebApplication({ adapter: node() })
    await app.bootstrap()

    const res = await app.request('/status/created', { method: 'POST' })

    expect(res.status).toBe(201)
  })

  it('leaves the status code to the server when @Status is not set', async () => {
    @Controller('/status-default')
    class StatusDefaultController {
      @Get('/ok')
      get() {
        return { ok: true }
      }
    }

    void [StatusDefaultController]

    const app = createWebApplication({ adapter: node() })
    await app.bootstrap()

    const res = await app.request('/status-default/ok')

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

    const app = createWebApplication({ adapter: node() })
    await app.bootstrap()

    const res = await app.request('/status-empty/ok')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })
})
