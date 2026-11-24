import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication } from './application.js'
import { type ActionResult, BindTo, Controller, Get, type WebApplication } from './index.js'
import { node } from './platform/node.testkit.js'

/**
 * A controller bound to a name no installed server has stops the application at start-up rather than landing anywhere:
 * serving it on the application's own server would expose what its binding kept off it.
 *
 * Isolated: a `@Controller` registers into the process-wide registry, so every application in this file serves it.
 */

@BindTo('nowhere')
@Controller('/jobs')
class JobsController {
  @Get('/')
  list(): ActionResult {
    return []
  }
}

void [JobsController]

describe('a controller bound to a name no server has', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close().catch(() => undefined)
    app = undefined
  })

  it('refuses to start, naming the controller and the servers there are', async () => {
    app = createWebApplication({ adapter: node() }).listener('admin') as WebApplication

    const error = await app.bootstrap().catch((error: unknown) => error)

    expect(error).toMatchObject({ code: 'ERR_CONFIGURATION' })
    expect((error as Error).message).toMatch(
      /^Cannot serve controller "JobsController": it is bound to "nowhere" with @BindTo, and no installed server has that name/,
    )
    expect((error as Error).message).toContain(`.listener('nowhere', ...)`)
    expect((error as Error).message).toContain('"admin"')
  })

  it('offers only to add the listener when none is installed', async () => {
    app = createWebApplication({ adapter: node() }) as WebApplication

    const error = await app.bootstrap().catch((error: unknown) => error)

    expect((error as Error).message).toContain(`.listener('nowhere', ...)`)
    expect((error as Error).message).not.toContain('Or bind it to an installed server')
  })
})
