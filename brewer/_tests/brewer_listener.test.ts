import { Router, createWebApplication } from '@caffeinejs/http'
import { node } from '@caffeinejs/http-node'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { brewer } from '../brewer.js'

/**
 * A client reaches the routes a listener serves the way it reaches any others: given that server's origin. Its types
 * are the routers the listener mounts.
 */

const listener = { host: '127.0.0.1', port: 0 }

const metrics = new Router('/metrics').get('/').handler(() => ({ up: true }))

const pets = new Router('/pets').get('/').handler(() => [{ id: 1 }])

const app = createWebApplication({ adapter: node() })
  // A listener's settings are typed by the application's adapter; under `node()`, `listen` is what it reads.
  .listener('admin', l => l.server(() => ({ listen: listener }) as never).mount(metrics))
  .server(() => ({ listen: listener }))
  .mount(pets)

beforeAll(async () => {
  await app.run()
})

afterAll(async () => {
  await app.close()
})

describe('brewer against a listener', () => {
  it("should call the routes the server serves, given the server's origin", async () => {
    const admin = brewer<typeof metrics>(app.listeners.get('admin')!.address!.origin)

    expect(await (await admin.metrics.get()).json()).toEqual({ up: true })
  })

  it('should find the routes of each server only at its own origin', async () => {
    const adminOrigin = app.listeners.get('admin')!.address!.origin
    const adminPets = brewer<typeof pets>(adminOrigin)
    const ownMetrics = brewer<typeof metrics>(app.address!.origin)
    const ownPets = brewer<typeof pets>(app.address!.origin)

    expect((await adminPets.pets.get()).status).toBe(404)
    expect((await ownMetrics.metrics.get()).status).toBe(404)
    expect(await (await ownPets.pets.get()).json()).toEqual([{ id: 1 }])
  })
})
