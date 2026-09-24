import { $p, Args, Controller, Get, createWebApplication, type Context, type WebApplication } from '@caffeinejs/http'
import { afterEach, describe, expect, it } from 'vitest'

import { MemoryHTTPCacheStore } from '../../store/memory/index.js'
import { CacheControl, HTTPCaching } from '../index.js'

/**
 * A cached page in an application served under a base path. It answers `/api/page` through the gateway and `/page`
 * straight to the application, and renders links from the base it was reached under: replaying one to the other
 * would send the browser somewhere the gateway does not route.
 */

@Controller('/based')
class BasedController {
  @CacheControl({ ttl: 60 })
  @Get('/page')
  @Args([$p.context()])
  page(ctx: Context) {
    return { next: `${ctx.req.basePath}/next` }
  }
}

void [BasedController]

describe('caching under a base path', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('keeps a page answered under the base apart from the same page without it', async () => {
    app = createWebApplication()
      .basePath('/api')
      .with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
    await app.ready()

    const underMiss = await app.fetch('/api/based/page')
    const underHit = await app.fetch('/api/based/page')
    const directMiss = await app.fetch('/based/page')
    const directHit = await app.fetch('/based/page')

    expect([underMiss, underHit, directMiss, directHit].map(res => res.headers.get('x-cache'))).toEqual([
      'MISS',
      'HIT',
      'MISS',
      'HIT',
    ])
    expect(await underHit.json()).toEqual({ next: '/api/next' })
    expect(await directHit.json()).toEqual({ next: '/next' })
  })
})
