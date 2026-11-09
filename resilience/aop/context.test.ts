import { AsyncLocalStorage } from 'node:async_hooks'

import { createApplication, type Feature } from '@caffeinejs/application'
import { CaffeineIoC } from '@caffeinejs/di'
import { Millisecond, Second } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { fakeTimersClock } from '../clock.testkit.js'
import { ErrInvalidOption } from '../errors.js'
import { ErrTimeLimitExceeded } from '../timelimiter/timelimiter.js'
import { Resilient } from './annotations.js'
import { ResilienceContext } from './context.js'
import { Resilience, type ResilienceBuilder } from './feature.js'

const opened: Array<() => Promise<unknown>> = []

afterEach(async () => {
  vi.useRealTimers()
  for (const close of opened.splice(0)) {
    await close()
  }
})

// What a service below the annotated method saw on each attempt.
interface Seen {
  readonly attempt: number | undefined
  readonly signal: AbortSignal | undefined
}

class InventoryHTTP {
  seen: Seen[] = []
  context!: ResilienceContext

  async get(): Promise<string> {
    this.seen.push({ attempt: this.context.attempt, signal: this.context.signal })
    if (this.seen.length < 3) {
      throw new Error('blip')
    }
    return 'ok'
  }
}

class Ledger {
  http!: InventoryHTTP
  seen: Seen[] = []
  context!: ResilienceContext

  @Resilient('ledger')
  async post(): Promise<string> {
    await this.http.get().catch(() => undefined)
    this.seen.push({ attempt: this.context.attempt, signal: this.context.signal })
    return 'posted'
  }
}

class InventoryClient {
  http!: InventoryHTTP
  ledger!: Ledger

  // No signal parameter: the service below reads the attempt's own.
  @Resilient('inventory')
  async stock(): Promise<string> {
    return this.http.get()
  }

  @Resilient('inventory')
  async nested(): Promise<string> {
    return this.ledger.post()
  }
}

const presets = (r: ResilienceBuilder) =>
  r
    .preset('inventory', p => p.retry({ maxAttempts: 3, backoff: 0 }).timeLimiter({ timeoutDuration: 5 * Second }))
    .preset('ledger', p => p.retry({ maxAttempts: 2, backoff: 0 }))

// Boots an application with decorators off and the three classes wired by hand.
async function boot(feature: Feature) {
  const app = createApplication({ container: new CaffeineIoC({ decorators: false }) }).install(feature)
  app.container.bind(InventoryHTTP, t => t.toSelf())
  app.container.bind(Ledger, t => t.toSelf())
  app.container.bind(InventoryClient, t => t.toSelf())
  opened.push(() => app.close())
  await app.bootstrap()

  const context = app.container.get(ResilienceContext)
  const http = app.container.get(InventoryHTTP)
  const ledger = app.container.get(Ledger)
  const client = app.container.get(InventoryClient)
  Object.assign(http, { context })
  Object.assign(ledger, { http, context })
  Object.assign(client, { http, ledger })
  return { context, http, ledger, client }
}

describe('ResilienceContext', () => {
  // A service several calls below the annotated method must still stop at the attempt's deadline, and can tag it.
  it('gives code below an annotated method the attempt’s number and signal, on every retry', async () => {
    const { http, client } = await boot(Resilience(r => presets(r).context(new AsyncLocalStorage())))

    await expect(client.stock()).resolves.toBe('ok')

    expect(http.seen.map(seen => seen.attempt)).toEqual([1, 2, 3])
    const signals = http.seen.map(seen => seen.signal)
    expect(signals.every(signal => signal instanceof AbortSignal && !signal.aborted)).toBe(true)
    expect(new Set(signals).size).toBe(3)
  })

  it('reads the innermost attempt inside nested annotated methods', async () => {
    const { http, ledger, client } = await boot(Resilience(r => presets(r).context(new AsyncLocalStorage())))

    await expect(client.nested()).resolves.toBe('posted')

    // The ledger's attempt, numbered on its own, under the inventory's deadline: the ledger has no time limiter and
    // takes no signal, so it must not drop the one its caller runs under.
    expect(ledger.seen).toEqual([{ attempt: 1, signal: expect.any(AbortSignal) }])
    expect(http.seen).toEqual([{ attempt: 1, signal: ledger.seen[0]!.signal }])
  })

  // A deadline set above must still stop the work below, however many annotated methods sit between them.
  it('aborts the work below a nested method at the outer attempt’s deadline', async () => {
    const { context, ledger, client } = await boot(
      Resilience(r =>
        r
          .context(new AsyncLocalStorage())
          .preset('inventory', p => p.timeLimiter({ timeoutDuration: 50 * Millisecond, clock: fakeTimersClock }))
          .preset('ledger', p => p.retry({ maxAttempts: 1 })),
      ),
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let below: AbortSignal | undefined
    ledger.http = {
      get: () => {
        below = context.signal
        return new Promise(() => undefined)
      },
    } as unknown as InventoryHTTP

    const call = client.nested()
    const settled = expect(call).rejects.toThrow(ErrTimeLimitExceeded)
    await vi.advanceTimersByTimeAsync(50)
    await settled

    expect(below?.aborted).toBe(true)
  })

  it('reads undefined outside every attempt', async () => {
    const { context } = await boot(Resilience(r => presets(r).context(new AsyncLocalStorage())))

    expect(context.attempt).toBe(undefined)
    expect(context.signal).toBe(undefined)
  })

  // Reading it unconfigured would always answer undefined, which looks like "not in an attempt": fail instead.
  it('refuses a read when Resilience() was given no storage', async () => {
    const { context } = await boot(Resilience(presets))

    expect(() => context.attempt).toThrow(ErrInvalidOption)
    expect(() => context.signal).toThrow(
      'Cannot read the resilience context: Resilience() was given no context storage',
    )
  })

  it('refuses a storage without run and getStore', async () => {
    const error = await boot(Resilience(r => presets(r).context({ run: () => undefined } as never))).catch(
      (reason: unknown) => reason,
    )

    expect(error).toBeInstanceOf(ErrInvalidOption)
    expect((error as Error).message.split('\n')[0]).toBe(
      'Cannot use the resilience context storage: it must have run(store, callback) and getStore() methods, got an object',
    )
  })
})
