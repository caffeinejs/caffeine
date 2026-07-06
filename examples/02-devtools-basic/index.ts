import fastify from 'fastify'
import { CaffeineIoC, Injectable } from '@caffeinejs/core'
import { Controller, Delete, Get, Post, Params, createWebApplication } from '@caffeinejs/application'
import { body, fastifyAdapterFactory, param } from '@caffeinejs/http'
import { DevtoolsModule, DevtoolsServer } from '@caffeinejs/devtools'

// --- services ---

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

@Injectable([TaskStore])
class TaskLogger {
  #store: TaskStore

  constructor(store: TaskStore) {
    this.#store = store
  }

  log(action: string, id?: number): void {
    const count = this.#store.list().length
    console.log(`[tasks] ${action}${id !== undefined ? ` id=${id}` : ''} (total=${count})`)
  }
}

// --- controller ---

@Controller('/tasks', [TaskStore, TaskLogger])
class TaskController {
  #store: TaskStore
  #log: TaskLogger

  constructor(store: TaskStore, log: TaskLogger) {
    this.#store = store
    this.#log = log
  }

  @Get('/')
  list() {
    return this.#store.list()
  }

  @Post('/')
  @Params([body()])
  create(data: { name: string }) {
    const task = this.#store.add(data.name)
    this.#log.log('create', task.id)
    return task
  }

  @Delete('/:id')
  @Params([param('id')])
  remove(id: string) {
    const numId = Number(id)
    this.#store.remove(numId)
    this.#log.log('delete', numId)
    return { ok: true }
  }
}

void [TaskStore, TaskLogger, TaskController]

// --- bootstrap ---

const container = new CaffeineIoC(DevtoolsModule({ port: 9229 }))
const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), { container }).build()
await app.ready()

const devtools = container.get(DevtoolsServer)
devtools.attach(app).start()

await app.instance.listen({ port: 3000, host: '127.0.0.1' })
console.log('[app] HTTP server at http://localhost:3000')
console.log('[app] Devtools at http://localhost:9229')
