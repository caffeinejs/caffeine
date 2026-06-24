import { Worker } from 'node:worker_threads'
import { describe, it, expect } from 'vitest'

function runWorker<T>(url: URL): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const w = new Worker(url)
    w.on('message', resolve)
    w.on('error', reject)
  })
}

const workerUrl = new URL('./_worker_di.mjs', import.meta.url)

describe('CaffeineIoC in worker thread', function () {
  it('resolves a singleton to the same instance', async function () {
    const result = await runWorker<{ singletonIsSameInstance: boolean }>(workerUrl)
    expect(result.singletonIsSameInstance)
      .toBe(true)
  })

  it('singleton state persists across resolutions', async function () {
    const result = await runWorker<{ countAfterTwoIncrements: number }>(workerUrl)
    expect(result.countAfterTwoIncrements)
      .toBe(2)
  })

  it('fires @PostConstruct lifecycle hook', async function () {
    const result = await runWorker<{ postConstructFired: boolean, greeterMessage: string }>(workerUrl)
    expect(result.postConstructFired)
      .toBe(true)
    expect(result.greeterMessage)
      .toBe('hello from worker')
  })

  it('resolves constructor injections', async function () {
    const result = await runWorker<{ injectionWorks: boolean }>(workerUrl)
    expect(result.injectionWorks)
      .toBe(true)
  })

  it('two workers have isolated singleton instances', async function () {
    const [r1, r2] = await Promise.all([
      runWorker<{ countAfterTwoIncrements: number }>(workerUrl),
      runWorker<{ countAfterTwoIncrements: number }>(workerUrl),
    ])

    expect(r1.countAfterTwoIncrements)
      .toBe(2)
    expect(r2.countAfterTwoIncrements)
      .toBe(2)
  })
})
