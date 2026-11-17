import { newNoopLogger } from '@caffeinejs/application/logger'
import { Router, createWebApplication } from '@caffeinejs/http'
import { node } from '@caffeinejs/http/node'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { configuration } from '../../app.config.js'
import { TargetErrorHandler } from './errors.js'

const apps: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()))
})

describe('TargetErrorHandler', () => {
  // A page the UI failed to render is its own fault: the operator reads why in the log, beside the request it was.
  it('logs a failure that is not the devtools answering, with the request it was for, and renders a 500 page', async () => {
    const error = vi.fn()
    const app = createWebApplication({ adapter: node(), config: configuration })
      .logger(b => b.use({ ...newNoopLogger(), error }))
      .errorHandling(e => e.globalHandlers(TargetErrorHandler))
      .mount(
        new Router().get('/boom', () => {
          throw new Error('boom')
        }),
      )
    apps.push(app)
    await app.bootstrap()

    const res = await app.request('/boom')

    expect(res.status).toBe(500)
    expect(await res.text()).toContain('Cannot show the page')
    expect(error).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ message: 'boom' }), reqId: expect.any(String) }),
      'Cannot render the page',
    )
  })
})
