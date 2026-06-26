import fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CaffeineIoC } from '@caffeinejs/core'
import { Injectable } from '@caffeinejs/core/decorators'
import { Controller, Delete, Get, Post, Params, body, newHTTP, param } from '@caffeinejs/http'
import { fastifyAdapterFactory, type FastifyAdapter } from '@caffeinejs/http-fastify-adapter'
import { ErrNoRoutesForController, testClient } from './index.js'

@Injectable()
class TaskStore {
  #tasks: { id: number, name: string }[] = []
  #next = 1

  add(name: string): { id: number, name: string } {
    const task = { id: this.#next++, name }
    this.#tasks.push(task)
    return task
  }

  list(): { id: number, name: string }[] {
    return this.#tasks
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

  @Post('/')
  @Params([body()])
  create(data: { name: string }) {
    return this.#store.add(data.name)
  }

  @Delete('/:id')
  @Params([param('id')])
  remove(id: string) {
    this.#store.remove(Number(id))
    return { ok: true }
  }
}

void [TaskStore, TaskController]

class NoRouteController {}

describe('@caffeinejs/testing', () => {
  let baseUrl: string
  let adapter: FastifyAdapter

  beforeAll(async () => {
    const container = new CaffeineIoC()
    const app = newHTTP(fastifyAdapterFactory(fastify({ logger: false })), { container })
    adapter = await app.create()
    await adapter.ready()
    baseUrl = await adapter.listen({ port: 0, host: '127.0.0.1' })
  })

  afterAll(async () => {
    await adapter.close()
  })

  describe('testClient', () => {
    it('calls registered handlers via fetch Request', async () => {
      const client = testClient(TaskController, baseUrl)

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
      const client = testClient(TaskController, adapter)

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
      const client = testClient(TaskController, new URL(baseUrl))

      const listRes = await client.list(new Request(`${baseUrl}/tasks`))
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
      expect(() => testClient(NoRouteController, baseUrl)).toThrow(ErrNoRoutesForController)
    })
  })
})
