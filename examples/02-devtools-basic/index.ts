import { newConfiguration } from '@caffeinejs/application'
import { EnvConfigSource } from '@caffeinejs/application/config/env'
import { DevTool, ErrDevToolNotFound, type DevToolOperation } from '@caffeinejs/application/devtools'
import { $t } from '@caffeinejs/application/schema'
import { DevTools } from '@caffeinejs/devtools'
import { Injectable } from '@caffeinejs/di'
import {
  $p,
  Args,
  AuthenticateResult,
  Authentication,
  AuthenticationTicket,
  BaseAuthenticationHandler,
  Claim,
  Controller,
  Delete,
  Get,
  Identity,
  Post,
  Principal,
  type IContext,
} from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'

// --- configuration ---

// `TASKS_DB__PASSWORD` and `TASKS_DEVTOOLS__TOKEN` are secrets: `$t.Secret` keeps them masked in the devtools even
// though this application shows its configuration values there.
const ConfigSchema = $t.Object({
  server: $t.Object({ host: $t.String({ default: '127.0.0.1' }), port: $t.Integer({ default: 3000 }) }),
  db: $t.Object({
    url: $t.String({ default: 'postgres://tasks@localhost:5432/tasks' }),
    password: $t.Secret($t.String({ default: 'tasks-dev-password' })),
  }),
  devtools: $t.Object({
    port: $t.Integer({ default: 9090 }),
    token: $t.Secret($t.String({ default: 'dev-token' })),
  }),
})

const configuration = newConfiguration(ConfigSchema)
  .source(new EnvConfigSource({ prefix: 'TASKS_' }))
  .build().config

// --- services ---

interface Task {
  id: number
  name: string
}

@Injectable()
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

  find(id: number): Task | undefined {
    return this.#tasks.find(task => task.id === id)
  }

  remove(id: number): void {
    this.#tasks = this.#tasks.filter(task => task.id !== id)
  }
}

// --- a devtool of the application's own: GET /devtools/tasks, GET /devtools/tasks/:id, DELETE /devtools/tasks ---

@Injectable([TaskStore])
class TasksTool extends DevTool {
  readonly id = 'tasks'
  readonly title = 'Tasks'
  readonly description = 'The tasks the store holds, and clearing them'
  readonly operations: DevToolOperation[] = [
    { method: 'GET', path: '', handle: () => ({ count: this.store.list().length, tasks: this.store.list() }) },
    {
      method: 'GET',
      path: '/:id',
      handle: ({ params }) => {
        const task = this.store.find(Number(params.id))
        if (task === undefined) {
          throw new ErrDevToolNotFound(`No task "${params.id}"`)
        }
        return task
      },
    },
    { method: 'DELETE', path: '', handle: () => this.store.list().forEach(task => this.store.remove(task.id)) },
  ]

  constructor(private readonly store: TaskStore) {
    super()
  }
}

// --- controller ---

@Controller('/tasks', [TaskStore])
class TaskController {
  constructor(private readonly store: TaskStore) {}

  @Get('/')
  list(): Task[] {
    return this.store.list()
  }

  @Post('/')
  @Args([$p.body()])
  create(data: { name: string }): Task {
    return this.store.add(data.name)
  }

  @Delete('/:id')
  @Args([$p.param('id')])
  remove(id: string): { ok: true } {
    this.store.remove(Number(id))
    return { ok: true }
  }
}

void [TaskController, TasksTool]

// --- authentication: the devtools answer `Authorization: Bearer <devtools.token>` and nothing else ---

class DevToolsToken extends BaseAuthenticationHandler<object> {
  constructor(private readonly token: string) {
    super({})
  }

  async authenticate(ctx: IContext): Promise<AuthenticateResult> {
    if (ctx.req.header('authorization') !== `Bearer ${this.token}`) {
      return AuthenticateResult.none()
    }

    const ops = new Identity('Token', true, [new Claim('sub', 'ops', ''), new Claim('roles', 'ops', '')])

    return AuthenticateResult.success(new AuthenticationTicket(new Principal(true, [ops]), 'Token'))
  }
}

// --- bootstrap ---

const app = createWebApplication({ config: configuration })
  .server(({ config }) => ({ listener: config.server }))
  .install(Authentication((a, { config }) => a.addStrategy('Token', new DevToolsToken(config.devtools.token))))
  // The devtools on a server of their own, on loopback, for an `ops` principal alone. The tasks API stays open: no
  // route of it declares anything, and the application sets no fallback policy.
  .install(
    DevTools((d, { config }) =>
      d
        .port(config.devtools.port)
        .authorize({ roles: ['ops'] })
        .showConfigValues(),
    ),
  )

const { address } = await app.run()
const devtools = app.listeners.get('devtools')!.address!.origin

console.log(`[app] Tasks API at ${address.origin}/tasks`)
console.log(`[app] Devtools at ${devtools}/devtools`)
console.log(`[app] Try: curl -H "Authorization: Bearer dev-token" ${devtools}/devtools/routes`)
console.log(
  `[app] UI:  CAFFEINE_DEVTOOLS_TARGET__URL=${devtools}/devtools CAFFEINE_DEVTOOLS_TARGET__AUTHORIZATION="Bearer dev-token" make devtools`,
)
