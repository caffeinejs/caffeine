import { HTTPCaching, cacheControl } from '@caffeinejs/caching/http'
import { MemoryHTTPCacheStore } from '@caffeinejs/caching/store/memory'
import { Router, createWebApplication } from '@caffeinejs/http'

import { PRODUCTS, TTL_SECONDS } from '../payload.js'

const PORT = parseInt(process.env.PORT ?? '3000', 10)
const cached = process.env.BENCH_CACHE !== 'off'

const api = new Router('')
api.get('/health', () => ({ ok: true }))

const products = api.get('/api/products')
if (cached) {
  products.with(cacheControl({ ttl: TTL_SECONDS }))
}
products.handler(() => PRODUCTS)

const app = cached
  ? createWebApplication()
      .with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      .mount(api)
  : createWebApplication().mount(api)

await app.ready()
await app.instance.listen({ port: PORT, host: '0.0.0.0' })
