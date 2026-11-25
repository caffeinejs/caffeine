import { afterEach, expect, it } from 'vitest'

import { type WebApplication, createWebApplication } from './application.js'
import { type ActionResult, Controller, Get, HTTPPlugin, Router, Use } from './index.js'
import { node } from './platform/node.testkit.js'

/**
 * Start-up runs each listener's callback first, since it describes a server, then each server's plugins: its own, its
 * routers', then its controllers'.
 *
 * Isolated: a `@Controller` registers into the process-wide registry, so every application in this file serves it.
 */

const order: string[] = []

/** A plugin that does nothing but record that its factory ran. */
function recording(name: string): () => HTTPPlugin {
  return () => {
    order.push(name)
    return new (class extends HTTPPlugin {
      register(): void {}
    })()
  }
}

@Use(recording('controller plugin'))
@Controller('/jobs')
class JobsController {
  @Get('/')
  list(): ActionResult {
    return []
  }
}

void [JobsController]

let app: WebApplication | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

it("runs a listener's callback before any plugin, then a server's routers' plugins before its controllers'", async () => {
  app = createWebApplication({ adapter: node() })
    .listener('admin', () => void order.push('listener callback'))
    .mount(new Router('/api').with(recording('router plugin')).get('/', () => 'api')) as WebApplication

  await app.bootstrap()

  expect(order).toEqual(['listener callback', 'router plugin', 'controller plugin'])
})
