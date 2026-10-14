import { Worker } from 'node:worker_threads'

import { describe, it, expect } from 'vitest'

function runWorker<T>(url: URL): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const w = new Worker(url)
    w.on('message', resolve)
    w.on('error', reject)
    // A no-op once the result arrived: a worker's messages are delivered before its `exit`.
    w.on('exit', code => reject(new Error(`Worker exited with code ${code} before posting a result`)))
  })
}

const workerURL = new URL('./_worker_di.mjs', import.meta.url)

// Each worker compiles the container from source through tsx, which takes seconds on a busy machine.
describe('CaffeineIoC in worker thread', { timeout: 30_000 }, function () {
  it('resolves a singleton to the same instance', async function () {
    const result = await runWorker<{ singletonIsSameInstance: boolean }>(workerURL)
    expect(result.singletonIsSameInstance).toBe(true)
  })

  it('singleton state persists across resolutions', async function () {
    const result = await runWorker<{ countAfterTwoIncrements: number }>(workerURL)
    expect(result.countAfterTwoIncrements).toBe(2)
  })

  it('fires @PostConstruct lifecycle hook', async function () {
    const result = await runWorker<{ postConstructFired: boolean; greeterMessage: string }>(workerURL)
    expect(result.postConstructFired).toBe(true)
    expect(result.greeterMessage).toBe('hello from worker')
  })

  it('resolves constructor injections', async function () {
    const result = await runWorker<{ injectionWorks: boolean }>(workerURL)
    expect(result.injectionWorks).toBe(true)
  })

  it('two workers have isolated singleton instances', async function () {
    const [r1, r2] = await Promise.all([
      runWorker<{ countAfterTwoIncrements: number }>(workerURL),
      runWorker<{ countAfterTwoIncrements: number }>(workerURL),
    ])

    expect(r1.countAfterTwoIncrements).toBe(2)
    expect(r2.countAfterTwoIncrements).toBe(2)
  })
})
