import { bench } from 'mitata'

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
