import { Hono } from 'hono'
import { cache } from 'hono/cache'
import { caches, install } from 'undici'

import { PRODUCTS, TTL_SECONDS } from '../payload.js'

const PORT = parseInt(process.env.PORT ?? '3054', 10)
const cached = process.env.BENCH_CACHE !== 'off'

// Hono's cache middleware stores responses through the Web Cache API, which Node does not provide. undici's
// in-memory `caches` only accepts its own `Response`, so its fetch globals replace Node's too. Both rows install
// them, so the only difference between them is the middleware.
install()
Object.assign(globalThis, { caches })

// The Node server captures the global `Response` when it loads, so it loads after `install()`. A static import
// would be hoisted above it.
const { serve } = await import('@hono/node-server')

const app = new Hono()

app.get('/health', c => c.json({ ok: true }))

if (cached) {
  app.get(
    '/api/products',
    cache({
      cacheName: 'products',
      cacheControl: `max-age=${TTL_SECONDS}`,
      // Without it the middleware stores through `executionCtx.waitUntil`, which the Node server does not provide.
      wait: true,
      // Without `caches` the middleware passes every request through; fail instead of measuring no cache.
      onCacheNotAvailable: reason => {
        throw new Error(reason)
      },
    }),
  )
}

app.get('/api/products', c => c.json(PRODUCTS))

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' })
