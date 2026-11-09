import fastify, { type FastifyServerOptions } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { ErrConfiguration } from '../../../core/error/common.js'
import type { NodeMiddleware } from '../../../core/middleware/middleware.js'
import type { WebApplication } from '../../../index.js'
import { createWebApplication, newRouter } from '../index.js'
import { installMiddlewares } from './middleware.js'

let app: WebApplication | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

// Blocks every request that does not carry the key, the way a path-scoped auth middleware would.
const guard: NodeMiddleware = (req, res, next) => {
  if (req.headers['x-api-key'] !== 'key') {
    res.statusCode = 401
    res.end('blocked')
    return
  }
  next()
}

async function guarded(factory: FastifyServerOptions): Promise<WebApplication> {
  app = createWebApplication()
    .server(() => ({ factory }))
    .mount(newRouter().get('/secret', () => ({ secret: true }))) as WebApplication
  app.use('/secret', guard)
  await app.bootstrap()

  return app
}

describe('installMiddlewares', () => {
  // `initialConfig` gives each flag a `routerOptions` object leaves out its default, over the top-level flag the
  // router still reads: a guard matching paths from it lets through a spelling the router sends to the route.
  it('guards every spelling the router sends to the path when routerOptions leaves top-level flags out', async () => {
    const server = await guarded({
      ignoreDuplicateSlashes: true,
      ignoreTrailingSlash: true,
      useSemicolonDelimiter: true,
      routerOptions: { caseSensitive: false },
    })

    for (const url of ['/secret', '/SECRET', '//secret', '/secret/', '/secret;a=b']) {
      expect((await server.request(url)).status, url).toBe(401)
    }
    expect((await server.request('//secret', { headers: { 'x-api-key': 'key' } })).status).toBe(200)
  })

  it('guards every spelling the router sends to the path when routerOptions sets the flags', async () => {
    // find-my-way reads `useSemicolonDelimiter` from its options, but Fastify's types do not declare it there.
    const routerOptions = { ignoreDuplicateSlashes: true, ignoreTrailingSlash: true, useSemicolonDelimiter: true }
    const server = await guarded({ routerOptions })

    for (const url of ['/secret', '//secret', '/secret/', '/secret;a=b']) {
      expect((await server.request(url)).status, url).toBe(401)
    }
  })

  // The flags it matches paths by are recorded as the adapter builds the server; guessing them would reopen the gap.
  it('refuses a server the adapter did not build', () => {
    expect(() => installMiddlewares(fastify(), [{ path: '/secret', fn: guard, hook: undefined }])).toThrow(
      ErrConfiguration,
    )
  })
})
