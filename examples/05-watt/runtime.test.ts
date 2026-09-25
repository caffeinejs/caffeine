import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { create } from '@platformatic/runtime'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

type Runtime = Awaited<ReturnType<typeof create>>
type RuntimeConfig = Exclude<Parameters<typeof create>[1], string | undefined>

// What Watt's `/ready` and `/status` aggregate: one verdict per worker, keyed `<application>:<worker>`. Not in Watt's
// typings, but reading it is the only way to tell a passing check from a missing one — with no custom check
// registered, `/ready` passes on "every worker started" alone.
interface CheckedRuntime {
  getCustomReadinessChecks(): Promise<Record<string, unknown>>
  getCustomHealthChecks(): Promise<Record<string, unknown>>
}

// The example as Watt runs it: the compiled entries, each in a worker thread of Watt's own runtime. Only the ports
// differ from `watt.json`, with any free one for the entrypoint and no probe server, so the suite can run next to a
// `make example:watt` without either taking the other's port.
describe('the example under Watt', () => {
  let runtime: Runtime | undefined
  let url: string

  beforeAll(async () => {
    const config = JSON.parse(await readFile(new URL('watt.json', import.meta.url), 'utf8')) as RuntimeConfig
    delete config.healthProbes

    runtime = await create(
      fileURLToPath(new URL('.', import.meta.url)),
      { ...config, server: { hostname: '127.0.0.1', port: 0 }, logger: { level: 'warn' } },
      // Watt's signal handling belongs to the process it runs in, and here that process is the test runner.
      { setupSignals: false },
    )

    const started = await runtime.start()
    if (started === undefined) {
      throw new Error('Watt started no entrypoint')
    }
    url = started
  })

  afterAll(async () => {
    if (runtime?.getRuntimeStatus() !== 'closed') {
      await runtime?.close()
    }
  })

  it('serves the entrypoint under the base path its watt.json names', async () => {
    const response = await fetch(new URL('/shop/', url))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ application: 'web' })
  })

  it('reaches the internal application through the runtime, in process', async () => {
    const response = await fetch(new URL('/shop/orders', url))

    expect(await response.json()).toEqual([{ id: 1, item: 'espresso' }])
  })

  it('answers Watt readiness and liveness from every application, the headless worker included', async () => {
    const checked = runtime as unknown as CheckedRuntime
    const everyone = { 'web:0': { status: true }, 'orders:0': { status: true }, 'worker:0': { status: true } }

    expect(await checked.getCustomReadinessChecks()).toEqual(everyone)
    expect(await checked.getCustomHealthChecks()).toEqual(everyone)
  })

  // The entrypoint first, so nothing outside is still sending traffic in while the rest shut down. Watt reports an
  // application stopped once its worker has, which it does even for an entry that exports no close(): that part is
  // for the drain, not this spec, to show.
  it('stops the entrypoint first, then every other application', async () => {
    const stopped: string[] = []
    runtime?.on('application:stopped', (id: string) => stopped.push(id))

    await runtime?.close()

    expect(stopped[0]).toBe('web')
    expect([...stopped].sort()).toEqual(['orders', 'web', 'worker'])
  })
})
