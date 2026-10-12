import { createHash, timingSafeEqual } from 'node:crypto'

import {
  bindings,
  configuration,
  devTools,
  graph,
  health,
  info,
  routes,
  type DevToolsSlice,
} from '@caffeinejs/devtools'
import {
  Authentication,
  Claim,
  ErrHTTPBadRequest,
  Identity,
  Ops,
  Principal,
  Router,
  authentication,
  createWebApplication,
  healthProbes,
  newRouter,
} from '@caffeinejs/http'
import { newConfiguration } from '@caffeinejs/std'
import { EnvConfigSource } from '@caffeinejs/std/config/env'
import { InlineConfigSource } from '@caffeinejs/std/config/inline'
import { $t } from '@caffeinejs/std/schema'

// --- configuration ---

// Every key can be set from the environment: `TASKS_DEVTOOLS__PASSWORD` sets `devtools.password`. The name is the
// framework's own `caffeine` block, so it comes from a source rather than a default here.
const ConfigSchema = $t.Object({
  server: $t.Object({
    host: $t.String({ default: '127.0.0.1' }),
    port: $t.Number({ default: 3000 }),
  }),
  devtools: $t.Object({
    host: $t.String({ default: '127.0.0.1' }),
    port: $t.Number({ default: 9100 }),
    username: $t.String({ default: 'admin' }),
    password: $t.String({ default: 'admin' }),
  }),
})

const config = newConfiguration(ConfigSchema)
  .sources(new InlineConfigSource({ caffeine: { name: 'tasks' } }), new EnvConfigSource({ prefix: 'TASKS_' }))
  .build().config

// --- services ---

interface Task {
  id: number
  name: string
}

class TaskStore {
  #tasks: Task[] = []
  #next = 1

  add(name: string): Task {
    const task = { id: this.#next++, name }
    this.#tasks.push(task)
    return task
  }

  list(): Task[] {
    return this.#tasks
  }

  remove(id: number): void {
    this.#tasks = this.#tasks.filter(task => task.id !== id)
  }
}

// --- routes ---

const tasks = newRouter('/tasks')
  .get('/')
  .inject({ store: TaskStore })
  .handler((_ctx, { store }) => store.list())

  .post('/')
  .inject({ store: TaskStore })
  .handler((ctx, { store }) => {
    const { name } = (ctx.req.body() ?? {}) as { name?: unknown }
    if (typeof name !== 'string' || name === '') {
      throw new ErrHTTPBadRequest('Cannot add a task: "name" is required')
    }

    ctx.status(201)
    return store.add(name)
  })

  .delete('/:id')
  .inject({ store: TaskStore })
  .handler((ctx, { store }) => {
    store.remove(Number(ctx.req.param().id))
    return { ok: true }
  })

// --- devtools ---

// A slice of the example's own, next to the built-ins: what the store holds, at `GET /devtools/tasks`. Anything a
// package or an application wants to expose is one more `DevToolsSlice`.
const taskSlice: DevToolsSlice = {
  id: 'tasks',
  router: ({ container }) => {
    const store = container.get(TaskStore)

    return new Router().get('/', () => ({ count: store.list().length, tasks: store.list() }))
  },
}

// Compared through a digest of each, so the comparison takes the same time whatever the input.
const digest = (value: string) => createHash('sha256').update(value).digest()
const matches = (given: string, expected: string) => timingSafeEqual(digest(given), digest(expected))

// --- application ---

const app = createWebApplication({ config })
  .install(
    Authentication((a, { config }) =>
      a.addBasic('devtools', b =>
        b
          .realm('DevTools')
          .validate((_ctx, user, password) =>
            matches(user, config.devtools.username) && matches(password, config.devtools.password)
              ? new Principal(true, new Identity('Basic', true, [new Claim('sub', user, '')]))
              : null,
          ),
      ),
    ),
  )
  .install(
    // DevTools gets a port of its own, and its own authentication gate: nothing on the application's server reaches it.
    Ops('devtools', (o, { config }) =>
      o
        .server(() => ({ listener: { host: config.devtools.host, port: config.devtools.port } }))
        .with(authentication())
        .with(healthProbes())
        .with(
          devTools(d =>
            d
              .authorize({ schemes: ['devtools'] })
              .slices(bindings(), graph(), routes(), health(), info(), configuration(), taskSlice),
          ),
        ),
    ),
  )
  .server(({ config }) => ({ listener: config.server }))
  .mount(tasks)

app.container.bind(TaskStore, t => t.toClass(TaskStore))

const { address } = await app.run()

app.log.info(`Tasks API at ${address?.origin}/tasks`)
app.log.info(`DevTools at ${app.ops.get('devtools')?.address?.origin}/devtools, as "admin" unless configured`)
app.log.info('Read it with the DevTools UI: make devtools')
