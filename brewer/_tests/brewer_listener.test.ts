import { Router, bindTo } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { brewer } from '../brewer.js'

/**
 * A client reaches the routes a listener serves the way it reaches any others: given that server's origin. The
 * application's route types list them all; which server answers a route is the origin's to say.
 */

const listener = { host: '127.0.0.1', port: 0 }

const metrics = new Router('/metrics')
  .extend(bindTo('admin'))
  .get('/')
  .handler(() => ({ up: true }))

const pets = new Router('/pets').get('/').handler(() => [{ id: 1 }])

const app = createWebApplication()
  .listener('admin', l => l.server(() => ({ listener })))
  .server(() => ({ listener }))
  .mount(pets, metrics)

beforeAll(async () => {
  await app.run()
})

afterAll(async () => {
  await app.close()
})

describe('brewer against a listener', () => {
  it("should call the routes the server serves, given the server's origin", async () => {
    const admin = brewer<typeof app>(app.listeners.get('admin')!.address!.origin)

    expect(await (await admin.metrics.get()).json()).toEqual({ up: true })
  })

  it('should find the routes of each server only at its own origin', async () => {
    const admin = brewer<typeof app>(app.listeners.get('admin')!.address!.origin)
    const own = brewer<typeof app>(app.address!.origin)

    expect((await admin.pets.get()).status).toBe(404)
    expect((await own.metrics.get()).status).toBe(404)
    expect(await (await own.pets.get()).json()).toEqual([{ id: 1 }])
  })
})
