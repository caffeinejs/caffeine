import { Router, type WebApplication } from '@caffeinejs/http'
import { afterEach, describe, expect, it } from 'vitest'

import { info, type DevToolsIndex, type DevToolsSlice } from '../index.js'
import { OPERATOR, PROTECTED, get, target } from './fixtures.js'

class JobQueue {
  readonly jobs = new Map([['42', { id: '42', state: 'running' }]])
}

/** A slice from outside this package, as a third-party package would ship one. */
const jobs: DevToolsSlice = {
  id: 'jobs',
  router: ({ container }) => {
    const queue = container.get(JobQueue)

    return new Router()
      .get('/', () => ({ pending: queue.jobs.size }))
      .get('/:id', ctx => queue.jobs.get(ctx.req.param().id) ?? { id: ctx.req.param().id, state: 'unknown' })
  },
}

describe('a slice from outside the package', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  // The extension point: a slice nobody here knows about is listed, served and protected like a built-in.
  it('is listed, served under its id and protected like a built-in', async () => {
    app = target({ basic: true, devtools: d => d.authorize(PROTECTED).slices(info(), jobs) })
    app.container.bind(JobQueue, t => t.toClass(JobQueue))
    await app.bootstrap()

    const index = (await (await get(app, '/devtools', OPERATOR)).json()) as DevToolsIndex

    expect(index.slices).toEqual([
      { id: 'info', href: '/devtools/info' },
      { id: 'jobs', href: '/devtools/jobs' },
    ])

    expect((await get(app, '/devtools/jobs')).status).toBe(401)
    expect((await get(app, '/devtools/jobs/42')).status).toBe(401)

    const res = await get(app, '/devtools/jobs', OPERATOR)

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ pending: 1 })
    expect(await (await get(app, '/devtools/jobs/42', OPERATOR)).json()).toEqual({ id: '42', state: 'running' })
  })

  // `router` runs at start-up: what a slice cannot resolve fails `bootstrap()`, not the first request.
  it('fails start-up when what it resolves is missing', async () => {
    app = target({ devtools: d => d.slices(jobs) })

    await expect(app.bootstrap()).rejects.toThrow(/JobQueue/)
  })
})
