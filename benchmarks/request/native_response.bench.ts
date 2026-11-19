import { strictEqual } from 'node:assert'

import { createWebApplication, Router } from '@caffeinejs/http'

import { printMachineInfo } from '../machine-info.js'

const HTML = '<!doctype html><html><body><p>Hello, Ada!</p></body></html>'
const CONTENT_TYPE = 'text/html; charset=utf-8'
const WARMUP = 500
const REQUESTS = 1_000
const BATCHES = 5

const routes = new Router()
routes.get('/page').handler(() => new Response(HTML, { headers: { 'content-type': CONTENT_TYPE } }))
const app = createWebApplication({ logger: false }).mount(routes)

async function runBatch(count: number): Promise<number> {
  const start = performance.now()
  for (let i = 0; i < count; i++) {
    const response = await app.fetch(new Request('http://localhost/page'))
    strictEqual(response.status, 200)
    strictEqual(response.headers.get('content-type'), CONTENT_TYPE)
    strictEqual(await response.text(), HTML)
  }
  return performance.now() - start
}

printMachineInfo({ runtime: process.versions.bun ? 'bun' : 'node' })
await app.bootstrap()
try {
  await runBatch(WARMUP)

  const batchesMs: number[] = []
  for (let i = 0; i < BATCHES; i++) {
    batchesMs.push(await runBatch(REQUESTS))
  }
  const medianMs = batchesMs.toSorted((a, b) => a - b)[Math.floor(BATCHES / 2)]!
  console.log(
    JSON.stringify({
      requestsPerBatch: REQUESTS,
      batchesMs,
      medianMs,
      requestsPerSecond: (REQUESTS * 1_000) / medianMs,
    }),
  )
} finally {
  await app.close()
}
