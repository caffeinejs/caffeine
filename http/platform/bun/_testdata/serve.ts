// Run by `bun` from bun.test.ts: serves the built package with the Bun adapter, as `.server(...)` settings,
// `run(...)` options and the fixture's own flags from argv say. Prints a line for each `serverCallback`, then one with
// where the application and its listener listen.
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

import {
  $p,
  Args,
  bindTo,
  Controller,
  createWebApplication,
  Get,
  Post,
  Router,
  type IContext,
} from '../../../dist/index.js'
import { bun } from '../../../dist/platform/bun/index.js'

const settings = JSON.parse(process.argv[2] ?? '{}') as Record<string, unknown>
const runOptions = JSON.parse(process.argv[3] ?? '{}') as Record<string, unknown>
const flags = JSON.parse(process.argv[4] ?? '{}') as {
  listener?: boolean
  failCallback?: boolean
  backgroundWork?: boolean
}

if (settings.https === true) {
  settings.https = {
    key: readFileSync(new URL('../../../_tests/_testdata/tls/localhost.key', import.meta.url)),
    cert: readFileSync(new URL('../../../_tests/_testdata/tls/localhost.crt', import.meta.url)),
  }
}

@Controller('/who')
class WhoController {
  @Get('/')
  @Args([$p.context(), $p.address()])
  who(ctx: IContext, ip: string | undefined) {
    return { platform: ctx.platform.name, ip, remoteAddress: ctx.server.remoteAddress }
  }
}
void WhoController

// Answers with the body and every header the route read.
@Controller('/echo')
class EchoController {
  @Post('/')
  @Args([$p.body(), $p.header()])
  echo(body: unknown, headers: Record<string, string>) {
    return { body, headers }
  }
}
void EchoController

let callbackPort: number | undefined

const app = createWebApplication({ adapter: bun() })
  .server(() => settings)
  .serverCallback((_, server) => {
    callbackPort = server.port
    console.log(JSON.stringify({ callback: server.port }))
    if (flags.failCallback === true) {
      throw new Error('callback failed')
    }
  })
  .shutdown(s => s.signals(['SIGTERM']))

if (flags.listener === true) {
  app
    .listener('admin', l => l.server(() => ({ listen: { host: '127.0.0.1', port: 0 } })))
    .mount(
      new Router('/admin')
        .extend(bindTo('admin'))
        .get('/')
        .handler(() => ({ admin: true })),
    )
}

// Answers once the process is told to stop: a request in flight when the shutdown starts.
app.mount(
  new Router('/hold').get('/').handler(async () => {
    console.log(JSON.stringify({ held: true }))
    await new Promise(resolve => process.once('SIGTERM', resolve))
    return { drained: true }
  }),
)

const work = Promise.withResolvers<void>()
if (flags.backgroundWork === true) {
  app
    .shutdown(s => s.drainDelay(0))
    .hook('onClose', () => console.log(JSON.stringify({ onClose: true })))
    .mount(
      new Router('/work').get('/').handler(ctx => {
        const waitUntil = ctx.server.waitUntil!
        waitUntil(work.promise.then(() => console.log(JSON.stringify({ workCompleted: true }))))
        return 'answered'
      }),
    )
}

try {
  await app.run(runOptions)
} catch (err) {
  if (flags.failCallback !== true) {
    throw err
  }

  // Whether the server the callback was handed still answers once start-up has failed.
  const reachable = await fetch(`http://127.0.0.1:${callbackPort}/who`).then(
    () => true,
    () => false,
  )
  console.log(JSON.stringify({ failed: (err as Error).message.split('\n')[0], reachable }))
  process.exit(1)
}

const { host, origin, path } = app.address!
const admin = flags.listener === true ? app.listeners.get('admin')!.address!.origin : undefined
console.log(JSON.stringify({ host, origin, path, admin }))

if (flags.backgroundWork === true) {
  const input = createInterface({ input: process.stdin })
  const commands = input[Symbol.asyncIterator]()

  try {
    if ((await commands.next()).value !== 'close') {
      throw new Error('Expected close command')
    }
    const closing = app.close()
    // Let teardown start, then read the closing engine's response before acknowledging shutdown.
    await new Promise<void>(resolve => setImmediate(resolve))
    const response = await app.request('/who')
    await response.text()
    console.log(JSON.stringify({ closingStatus: response.status }))

    if ((await commands.next()).value !== 'release') {
      throw new Error('Expected release command')
    }
    work.resolve()
    await closing
    console.log(JSON.stringify({ closed: true }))
  } finally {
    work.resolve()
    input.close()
  }
}
