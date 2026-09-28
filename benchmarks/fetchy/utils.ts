import { bench } from 'mitata'

/**
 * Sends `rounds` batches of `concurrency` calls without measuring them.
 */
export async function warmUp(concurrency: number, rounds: number, fn: () => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.all(Array.from({ length: concurrency }, fn))
  }
}

export function concurrentBench(name: string, concurrency: number, fn: () => Promise<unknown>): void {
  bench(name, function* () {
    yield {
      concurrency,
      async bench() {
        await fn()
      },
    }
  })
}
