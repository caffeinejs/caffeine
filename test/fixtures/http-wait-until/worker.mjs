import { createWebApplication, ErrConfiguration, Router } from '@caffeinejs/http'

// The default matcher generates code at route registration, which workerd refuses.
function exactMatcher() {
  const routes = new Map()

  return {
    add(method, path, _constraints, store) {
      routes.set(method + ' ' + path, store)
    },
    match(method, path) {
      const store = routes.get(method + ' ' + path)
      return store === undefined ? null : { store, params: {} }
    },
  }
}

async function complete(latch) {
  const held = await latch.fetch('http://latch/wait')
  const id = await held.text()
  await latch.fetch('http://latch/complete/' + id, { method: 'POST' })
}

const registrations = new WeakMap()

async function start(matcher) {
  const app = createWebApplication()
    .mount(
      new Router()
        .get('/ready', () => 'ready')
        .get('/work', ctx => {
          const { waitUntil } = ctx.server
          if (waitUntil === undefined) {
            return 'unsupported'
          }

          const [env, execution] = ctx.platform.runtime
          waitUntil(complete(env.LATCH))
          return { registrations: registrations.get(execution) }
        }),
    )
    .server(() => ({
      matcher,
      fetchWaitUntil: ([, execution]) => {
        if (execution === undefined) {
          return undefined
        }

        return work => {
          execution.waitUntil(work)
          registrations.set(execution, (registrations.get(execution) ?? 0) + 1)
        }
      },
    }))

  await app.bootstrap()
  return app
}

async function boot() {
  try {
    return await start()
  } catch (error) {
    if (
      !(error instanceof ErrConfiguration) ||
      !error.message.startsWith(
        'Cannot register "GET /ready": Code generation from strings disallowed for this context',
      )
    ) {
      throw error
    }

    return start(exactMatcher)
  }
}

let booting
export default {
  async fetch(request, env, execution) {
    const app = await (booting ??= boot())
    return app.fetch(request, env, request.headers.has('x-unsupported') ? undefined : execution)
  },
}
