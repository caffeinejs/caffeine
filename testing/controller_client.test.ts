import { Injectable } from '@caffeinejs/di'
import { WebApplication, Controller, Delete, Get, Post, Args, createWebApplication, $p } from '@caffeinejs/http'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { ErrNoRoutesForController, newURL, controllerClient } from './index.js'

@Injectable()
class TaskStore {
  #tasks: { id: number; name: string }[] = []
  #next = 1

  add(name: string): { id: number; name: string } {
    const task = { id: this.#next++, name }
    this.#tasks.push(task)
    return task
  }

  list(): { id: number; name: string }[] {
    return this.#tasks
  }

  find(id: number): { id: number; name: string } | undefined {
    return this.#tasks.find(t => t.id === id)
  }

  remove(id: number): void {
    this.#tasks = this.#tasks.filter(t => t.id !== id)
  }
}

@Controller('/tasks', [TaskStore])
class TaskController {
  #store: TaskStore

  constructor(store: TaskStore) {
    this.#store = store
  }

  @Get('/')
  list() {
    return this.#store.list()
  }

  @Get('/:id')
  @Args([$p.param('id')])
  find(id: string) {
    return this.#store.find(Number(id)) ?? { id: Number(id), name: 'unknown' }
  }

  @Post('/')
  @Args([$p.body()])
  create(data: { name: string }) {
    return this.#store.add(data.name)
  }

  @Delete('/:id')
  @Args([$p.param('id')])
  remove(id: string) {
    this.#store.remove(Number(id))
    return { ok: true }
  }
}

void [TaskStore, TaskController]

class NoRouteController {}

describe('controllerClient()', () => {
  let app: WebApplication<any, any, any>
  let baseURL: string

  beforeAll(async () => {
    app = createWebApplication()
    await app.ready()
    baseURL = await app.instance.listen({ port: 0, host: '127.0.0.1' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('calls registered handlers via fetch Request', async () => {
    const client = controllerClient(TaskController, baseURL)

    expect(client.list).toBeTypeOf('function')
    expect(client.create).toBeTypeOf('function')
    expect(client.remove).toBeTypeOf('function')

    const listRes = await client.list()
    expect(listRes.status).toBe(200)
    expect(await listRes.json()).toEqual([])

    const createRes = await client.create({
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'test' }),
    })
    expect(createRes.status).toBe(200)
    expect(await createRes.json()).toMatchObject({ id: 1, name: 'test' })
  })

  it('calls handler via in-process adapter', async () => {
    const client = controllerClient(TaskController, app)

    const listRes = await client.list()
    expect(listRes.status).toBe(200)
    expect(await listRes.json()).toBeInstanceOf(Array)

    const createRes = await client.create({
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'in-process' }),
    })
    expect(createRes.status).toBe(200)
    expect(await createRes.json()).toMatchObject({ name: 'in-process' })
  })

  it('calls registered handlers via URL instance', async () => {
    const client = controllerClient(TaskController, new URL(baseURL))

    const listRes = await client.list(new Request(`${baseURL}/tasks`))
    expect(listRes.status).toBe(200)
    expect(await listRes.json()).toBeInstanceOf(Array)

    const createRes = await client.create({
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'url-instance' }),
    })
    expect(createRes.status).toBe(200)
    expect(await createRes.json()).toMatchObject({ name: 'url-instance' })
  })

  it('throws when controller has no routes', () => {
    expect(() => controllerClient(NoRouteController, baseURL)).toThrow(ErrNoRoutesForController)
  })

  it('returns independent clients for same controller with different targets', async () => {
    const remote = controllerClient(TaskController, baseURL)
    const inProcess = controllerClient(TaskController, app)

    const [remoteRes, inProcessRes] = await Promise.all([remote.list(), inProcess.list()])

    expect(remoteRes.status).toBe(200)
    expect(inProcessRes.status).toBe(200)
  })

  it('reaches a path-param route via a newURL-built Request', async () => {
    const client = controllerClient(TaskController, app)
    const created = (await (
      await client.create({
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'findme' }),
      })
    ).json()) as { id: number }

    const res = await client.find(new Request(newURL('/tasks/:id').param('id', created.id).build()))

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: created.id, name: 'findme' })
  })
})

// Through a gateway, the base URL names the application's base path, and every request has to stay under it.
describe('controllerClient() against a base URL naming a base path', () => {
  const BASE = 'http://gw.test/api'

  function capturing(): string[] {
    const seen: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: Request) => {
        seen.push(request.url)
        return new Response('[]')
      }),
    )
    return seen
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends a route under the base path', async () => {
    const seen = capturing()

    await controllerClient(TaskController, BASE).list()

    expect(seen).toEqual([`${BASE}/tasks`])
  })

  it('moves a Request built for another origin under the base path', async () => {
    const seen = capturing()

    await controllerClient(TaskController, BASE).find(
      new Request(newURL('/tasks/:id').param('id', 7).query('x', 1).build()),
    )

    expect(seen).toEqual([`${BASE}/tasks/7?x=1`])
  })

  it('sends a Request already under the base path as it is, never adding the base twice', async () => {
    const seen = capturing()

    await controllerClient(TaskController, BASE).find(
      new Request(newURL('/tasks/:id').param('id', 7).baseURL(BASE).build()),
    )

    expect(seen).toEqual([`${BASE}/tasks/7`])
  })

  // However many slashes a base URL ends in, it names the same base path.
  it('sends a route under a base URL ending in slashes as under one ending in none', async () => {
    const seen = capturing()

    await controllerClient(TaskController, `${BASE}//`).list()

    expect(seen).toEqual([`${BASE}/tasks`])
  })

  it('moves a Request under a base URL ending in slashes, and sends one already under it as it is', async () => {
    const seen = capturing()
    const client = controllerClient(TaskController, `${BASE}//`)

    await client.find(new Request(newURL('/tasks/:id').param('id', 7).query('x', 1).build()))
    await client.find(new Request(newURL('/tasks/:id').param('id', 7).baseURL(BASE).build()))

    expect(seen).toEqual([`${BASE}/tasks/7?x=1`, `${BASE}/tasks/7`])
  })
})
