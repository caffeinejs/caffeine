import { AsyncLocalStorage } from 'node:async_hooks'

import { createApplication, type Feature } from '@caffeinejs/application'
import { CaffeineIoC } from '@caffeinejs/di'
import { Second } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it } from 'vitest'

import { ErrInvalidOption } from '../errors.js'
import { Resilient } from './annotations.js'
import { ResilienceContext } from './context.js'
import { Resilience, type ResilienceBuilder } from './feature.js'

const opened: Array<() => Promise<unknown>> = []

afterEach(async () => {
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

    // The ledger's attempt, not the inventory's: no time limiter of its own, so no signal, where the inventory's
    // attempt has one.
    expect(ledger.seen).toEqual([{ attempt: 1, signal: undefined }])
    expect(http.seen).toEqual([{ attempt: 1, signal: undefined }])
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
