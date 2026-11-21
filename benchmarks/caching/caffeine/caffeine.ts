import { HTTPCaching, cacheControl } from '@caffeinejs/caching/http'
import { MemoryHTTPCacheStore } from '@caffeinejs/caching/store/memory'
import { Router, createWebApplication } from '@caffeinejs/http'
import { node } from '@caffeinejs/http-node'
import { Second } from '@caffeinejs/std/duration'

import { PRODUCTS, TTL_SECONDS } from '../payload.js'

const PORT = parseInt(process.env.PORT ?? '3000', 10)
const cached = process.env.BENCH_CACHE !== 'off'

const api = new Router('')
api.get('/health', () => ({ ok: true }))

const products = api.get('/api/products')
if (cached) {
  products.options(cacheControl({ ttl: TTL_SECONDS * Second }))
}
products.handler(() => PRODUCTS)

const app = cached
  ? createWebApplication({ adapter: node() })
      .with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      .mount(api)
  : createWebApplication({ adapter: node() }).mount(api)

await app.run({ port: PORT, host: '0.0.0.0' })
