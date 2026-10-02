import { Ops, Router, bindTo, createWebApplication } from '@caffeinejs/http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { brewer } from '../brewer.js'

/**
 * A client reaches the routes an ops server serves the way it reaches any others: given that server's origin. The
 * application's route types list them all; which server answers a route is the origin's to say.
 */

const listener = { host: '127.0.0.1', port: 0 }

const metrics = new Router('/metrics')
  .with(bindTo('admin'))
  .get('/')
  .handler(() => ({ up: true }))

const pets = new Router('/pets').get('/').handler(() => [{ id: 1 }])

const app = createWebApplication()
  .install(Ops('admin', o => o.server(() => ({ listener }))))
  .server(() => ({ listener }))
  .mount(pets, metrics)

beforeAll(async () => {
  await app.run()
})

afterAll(async () => {
  await app.close()
})

describe('brewer against an ops server', () => {
  it("should call the routes the server serves, given the server's origin", async () => {
    const ops = brewer<typeof app>(app.ops.get('admin')!.address!.origin)

    expect(await (await ops.metrics.get()).json()).toEqual({ up: true })
  })

  it('should find the routes of each server only at its own origin', async () => {
    const ops = brewer<typeof app>(app.ops.get('admin')!.address!.origin)
    const own = brewer<typeof app>(app.address!.origin)

    expect((await ops.pets.get()).status).toBe(404)
    expect((await own.metrics.get()).status).toBe(404)
    expect(await (await own.pets.get()).json()).toEqual([{ id: 1 }])
  })
})
