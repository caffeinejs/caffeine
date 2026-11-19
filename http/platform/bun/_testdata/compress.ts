// Run by `bun` from http/core/compress/compress.testkit.ts: serves the built package with the Bun adapter,
// `compression()` and `decompression()`, then prints one line with where it listens. It sits here because only
// http/platform/ may import the Bun adapter.

import { GiB } from '@caffeinejs/std/bytes'

import { compression, decompression } from '../../../dist/core/compress/index.js'
import { createWebApplication, Router } from '../../../dist/index.js'
import { bun } from '../../../dist/platform/bun/index.js'

const PETS = { pets: Array.from({ length: 40 }, (_, i) => ({ id: i, name: `pet number ${i}` })) }

const app = createWebApplication({ adapter: bun() })
  .with(compression())
  .with(decompression())
  .mount(
    new Router('/pets').get('/').handler(() => PETS),
    new Router('/stream').get('/').handler(ctx => {
      ctx.header('content-type', 'text/plain')
      const parts = ['one ', 'two ', 'three']
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          const next = parts.shift()
          if (next === undefined) {
            controller.close()
          } else {
            controller.enqueue(new TextEncoder().encode(next))
          }
        },
      })
    }),
    new Router('/echo').post('/').handler(ctx => ({ value: ctx.req.body() })),
    // Above the largest buffer Bun makes: 4 GiB.
    new Router('/huge')
      .post('/')
      .bodyLimit(5 * GiB)
      .handler(ctx => ({ value: ctx.req.body() })),
  )

await app.run({ host: '127.0.0.1', port: 0 })

console.log(JSON.stringify({ origin: app.address!.origin }))
