import { $aop, CaffeineIoC, Injectable, type JoinPoint, type MethodAspect, Profile, token } from '@caffeinejs/di'
import { Controller, type IContext, Post } from '@caffeinejs/http'
import { ErrCallRefused, exponential } from '@caffeinejs/resilience'
import {
  Bulkhead,
  CircuitBreaker,
  Fallback,
  RateLimiter,
  Resilience,
  ResilienceRegistry,
  Retry,
  TimeLimiter,
} from '@caffeinejs/resilience/aop'
import { ResilienceErrorHandler, ResilienceHTTP } from '@caffeinejs/resilience/http'
import { ErrTimeLimitExceeded } from '@caffeinejs/resilience/timelimiter'
import { Millisecond, Second } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it } from 'vitest'

import { startApp, type RunningApp } from './internal/app.js'
import { startPaymentProvider, type PaymentProvider } from './internal/payment_provider.js'
import { startProxy, type TCPProxy } from './internal/tcp_proxy.js'

/**
 * A checkout that charges a payment provider through every resilience strategy, over real sockets, with the outages a
 * provider has: blips, declines, answers lost after a charge, outages, overload and a shopper who leaves mid-payment.
 *
 * This file exists to prove the resilience layer never makes money go wrong. Every scenario ends against the
 * provider's ledger: no double charge, no lost charge, no order paid without a charge, and no outcome invented for a
 * call whose result is unknown. The provider deduplicates by `Idempotency-Key`; the gateway sends the same key on
 * every attempt, so a retry can never charge twice.
 */

const kProvider = token<string>('payment provider origin')

class CardDeclined extends Error {}
class ProviderUnavailable extends Error {}

interface Charge {
  readonly status: 'charged' | 'pending'
  readonly key: string
  readonly chargeId?: string
}

@Injectable([kProvider])
@Profile('e2e-resilience-payments')
class PaymentGateway {
  constructor(private readonly origin: string) {}

  // Only a refusal is deferred: the request never left, so "try later" is the truth. A timeout is not deferred: the
  // charge may have gone through, and only the provider knows.
  @Fallback('defer', { fallbackOn: error => error instanceof ErrCallRefused })
  @Retry('payments')
  @CircuitBreaker('payments')
  @RateLimiter('payments')
  @TimeLimiter('payments')
  @Bulkhead('payments')
  async charge(key: string, amount: number, card: string, signal?: AbortSignal): Promise<Charge> {
    let res: Response
    try {
      res = await fetch(`${this.origin}/charges`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({ amount, card }),
        signal,
      })
    } catch (error) {
      throw signal?.aborted === true
        ? signal.reason
        : new ProviderUnavailable('no answer from the provider', { cause: error })
    }
    if (res.status === 201) {
      const { chargeId } = (await res.json()) as { chargeId: string }
      return { status: 'charged', key, chargeId }
    }
    if (res.status === 402) {
      throw new CardDeclined(`card declined for ${key}`)
    }
    throw new ProviderUnavailable(`provider answered ${res.status}`)
  }

  async defer(_error: unknown, key: string): Promise<Charge> {
    return { status: 'pending', key }
  }

  async lookup(key: string): Promise<'charged' | 'declined' | undefined> {
    const res = await fetch(`${this.origin}/charges/${encodeURIComponent(key)}`)
    if (res.status === 404) {
      return undefined
    }
    return ((await res.json()) as { status: 'charged' | 'declined' }).status
  }
}

interface Order {
  readonly id: string
  readonly key: string
  readonly card: string
  readonly amount: number
  status: 'paying' | 'paid' | 'pending' | 'declined' | 'unknown'
  chargeId?: string
}

@Injectable()
@Profile('e2e-resilience-payments')
class OrderBook {
  readonly orders = new Map<string, Order>()

  open(id: string, key: string, card: string): Order {
    let order = this.orders.get(id)
    if (order === undefined) {
      order = { id, key, card, amount: 100 + id.length, status: 'paying' }
      this.orders.set(id, order)
    }
    return order
  }

  unsettled(): Order[] {
    return [...this.orders.values()].filter(order => order.status === 'pending' || order.status === 'unknown')
  }
}

// The ledger's writes land only when the unit of work around them commits.
const journal = { entries: [] as Array<{ orderId: string; chargeId: string }>, commits: 0, rollbacks: 0 }

@Injectable()
@Profile('e2e-resilience-payments')
class LedgerRepository {
  failNext = 0

  @Retry('ledger')
  async record(orderId: string, chargeId: string): Promise<void> {
    void orderId
    void chargeId
    if (this.failNext > 0) {
      this.failNext--
      throw new Error('deadlock detected')
    }
  }
}

class UnitOfWork implements MethodAspect<LedgerRepository> {
  async around(jp: JoinPoint<LedgerRepository>): Promise<unknown> {
    const [orderId, chargeId] = jp.args as [string, string]
    try {
      const result = await jp.proceed(...jp.args)
      journal.entries.push({ orderId, chargeId })
      journal.commits++
      return result
    } catch (error) {
      journal.rollbacks++
      throw error
    }
  }
}

type PaymentResult =
  | { readonly status: 'paid'; readonly chargeId: string }
  | { readonly status: 'pending' | 'declined' }
  | { readonly status: 'unknown'; readonly timedOut: boolean }

@Injectable([PaymentGateway, OrderBook, LedgerRepository])
@Profile('e2e-resilience-payments')
class PaymentService {
  constructor(
    private readonly gateway: PaymentGateway,
    private readonly book: OrderBook,
    private readonly ledger: LedgerRepository,
  ) {}

  async pay(orderId: string, key: string, card: string): Promise<PaymentResult> {
    const order = this.book.open(orderId, key, card)
    try {
      // The charge outlives the shopper's browser: a signal of its own, never the request's.
      const charge = await this.gateway.charge(order.key, order.amount, order.card, new AbortController().signal)
      if (charge.status === 'pending') {
        order.status = 'pending'
        return { status: 'pending' }
      }
      await this.settle(order, charge.chargeId!)
      return { status: 'paid', chargeId: charge.chargeId! }
    } catch (error) {
      if (error instanceof CardDeclined) {
        order.status = 'declined'
        return { status: 'declined' }
      }
      // Unknown, never failed: the provider may hold a charge the answer to which was lost.
      order.status = 'unknown'
      return { status: 'unknown', timedOut: error instanceof ErrTimeLimitExceeded }
    }
  }

  // Re-drives what is still open: a lookup first when the outcome is unknown, then a charge with the original key.
  async reconcile(): Promise<void> {
    for (const order of this.book.unsettled()) {
      const outcome = order.status === 'unknown' ? await this.gateway.lookup(order.key) : undefined
      if (outcome === 'declined') {
        order.status = 'declined'
      } else {
        await this.pay(order.id, order.key, order.card)
      }
    }
  }

  private async settle(order: Order, chargeId: string): Promise<void> {
    if (order.status !== 'paid') {
      await this.ledger.record(order.id, chargeId)
      order.status = 'paid'
      order.chargeId = chargeId
    }
  }
}

const STATUS: Record<PaymentResult['status'], number> = { paid: 201, pending: 202, declined: 402, unknown: 503 }

@Controller('/checkout', [PaymentService])
@Profile('e2e-resilience-payments')
class CheckoutController {
  constructor(private readonly payments: PaymentService) {}

  // No @Retry here: a POST handler that ran twice would pay twice. Load shedding never runs it twice.
  @Bulkhead('checkout')
  @Post('/:orderId/payment', p => [p.param('orderId'), p.header('idempotency-key'), p.body(), p.context()])
  async pay(orderId: string, key: string, body: { card: string }, ctx: IContext): Promise<PaymentResult> {
    const result = await this.payments.pay(orderId, key, body.card)
    ctx.status(result.status === 'unknown' && result.timedOut ? 504 : STATUS[result.status])
    return result
  }
}
void CheckoutController

interface Checkout {
  readonly app: RunningApp
  readonly provider: PaymentProvider
  readonly proxy: TCPProxy
  readonly container: CaffeineIoC
  readonly registry: ResilienceRegistry
  readonly book: OrderBook
  readonly service: PaymentService
}

const cleanups: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => undefined)
  }
  journal.entries = []
  journal.commits = 0
  journal.rollbacks = 0
})

async function checkout(providerOptions: { quota?: number; processing?: number } = {}): Promise<Checkout> {
  const provider = await startPaymentProvider({ quota: 60, ...providerOptions })
  cleanups.push(() => provider.close())
  const proxy = await startProxy({ host: '127.0.0.1', port: provider.port })
  cleanups.push(() => proxy.close())

  const container = new CaffeineIoC({ profiles: ['e2e-resilience-payments'] })
  container.bind(kProvider, t => t.toValue(`http://127.0.0.1:${proxy.port}`))
  container.aspect(UnitOfWork, s => s.toSelf().pointcuts($aop.forClass(LedgerRepository, 'record')))
  const app = await startApp(
    a =>
      a
        .install(
          Resilience(r =>
            r
              .retry('payments', {
                maxAttempts: 6,
                backoff: exponential({ initialDelay: 50 * Millisecond, maxDelay: 200 * Millisecond }),
                retryOn: error => !(error instanceof CardDeclined),
              })
              .circuitBreaker('payments', {
                minimumNumberOfCalls: 6,
                slidingWindow: { type: 'count', size: 6 },
                ignoreError: error => error instanceof CardDeclined,
                waitDurationInOpenState: 200 * Millisecond,
                automaticTransitionFromOpenToHalfOpen: true,
                permittedNumberOfCallsInHalfOpenState: 2,
              })
              .rateLimiter('payments', {
                limitForPeriod: 25,
                limitRefreshPeriod: 1 * Second,
                maxWaitDuration: 1 * Second,
              })
              .timeLimiter('payments', { timeoutDuration: 250 * Millisecond })
              .bulkhead('payments', { maxConcurrentCalls: 10, maxQueuedCalls: 20, maxWaitDuration: 2 * Second })
              .bulkhead('checkout', { maxConcurrentCalls: 200, maxQueuedCalls: 200, maxWaitDuration: 10 * Second })
              .retry('ledger', { maxAttempts: 3, backoff: 0 }),
          ),
        )
        .install(ResilienceHTTP())
        .errorHandling(e => e.globalHandlers(ResilienceErrorHandler)),
    { container },
  )
  cleanups.push(() => app.close())

  return {
    app,
    provider,
    proxy,
    container,
    registry: container.get(ResilienceRegistry),
    book: container.get(OrderBook),
    service: container.get(PaymentService),
  }
}

interface Answer {
  readonly status: number
  readonly body: Record<string, unknown>
  readonly retryAfter: string | null
}

async function pay(c: Checkout, orderId: string, card = '4242', key = `key-${orderId}`): Promise<Answer> {
  const res = await fetch(`${c.app.origin}/checkout/${orderId}/payment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ card }),
  })
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
    retryAfter: res.headers.get('retry-after'),
  }
}

// Waits until the breaker lets trial calls through again, when it is open.
async function untilBreakerAdmits(c: Checkout): Promise<void> {
  const breaker = c.registry.circuitBreaker('payments')
  if (breaker.state !== 'open') {
    return
  }
  await new Promise<void>(resolve => {
    const off = breaker.on('stateChange', event => {
      if (event.to !== 'open') {
        off()
        resolve()
      }
    })
  })
}

// Settles every open order, as a reconciliation job would, until none is left or `rounds` run out.
async function reconcile(c: Checkout, rounds = 10): Promise<void> {
  for (let round = 0; round < rounds && c.book.unsettled().length > 0; round++) {
    await untilBreakerAdmits(c)
    await c.service.reconcile()
  }
}

// What the provider holds and what the orders say must agree, whatever happened on the way.
function expectMoneyInvariants(c: Checkout, context = ''): void {
  const orders = [...c.book.orders.values()]
  const charged = [...c.provider.ledger.values()].filter(entry => entry.status === 'charged')

  expect(
    c.book.unsettled().map(order => order.id),
    `${context} orders left open`,
  ).toEqual([])
  for (const order of orders) {
    const entry = c.provider.ledger.get(order.key)
    if (order.status === 'paid') {
      expect(entry?.status, `${context} ${order.id} paid without a charge`).toBe('charged')
      expect(entry?.amount, `${context} ${order.id} charged the wrong amount`).toBe(order.amount)
      expect(order.chargeId, `${context} ${order.id} names another charge`).toBe(entry?.chargeId)
    }
    if (order.status === 'declined') {
      expect(entry?.status ?? 'declined', `${context} ${order.id} declined but charged`).toBe('declined')
    }
  }
  const paidKeys = new Set(orders.filter(order => order.status === 'paid').map(order => order.key))
  expect(
    charged.filter(entry => !paidKeys.has(entry.key)).map(entry => entry.key),
    `${context} charges no paid order owns`,
  ).toEqual([])
  expect(journal.entries.length, `${context} ledger entries`).toBe(paidKeys.size)
  expect(new Set(journal.entries.map(entry => entry.orderId)).size, `${context} an order recorded twice`).toBe(
    journal.entries.length,
  )
}

describe('a business-critical payment flow', { timeout: 60_000 }, () => {
  it('charges once and pays the order on the happy path', async () => {
    const c = await checkout()

    const answer = await pay(c, 'o-1')

    expect(answer.status).toBe(201)
    expect(c.provider.requests.get('key-o-1')).toBe(1)
    expect(c.book.orders.get('o-1')?.status).toBe('paid')
    expectMoneyInvariants(c)
  })

  // A decline is the customer's card, not the provider failing: never retried, and never a reason to open the breaker.
  it('treats a decline as final: one request, 402, and a breaker that stays closed after 200 of them', async () => {
    const c = await checkout({ quota: 1_000 })

    const first = await pay(c, 'd-0', 'declined')
    expect(first.status).toBe(402)
    expect(c.provider.requests.get('key-d-0')).toBe(1)

    for (let i = 1; i < 200; i++) {
      expect((await pay(c, `d-${i}`, 'declined')).status).toBe(402)
    }
    expect(c.registry.circuitBreaker('payments').state).toBe('closed')
    expect(c.provider.ledger.size).toBe(200)
    expectMoneyInvariants(c)
  })

  it('rides out two 503s with the same key, and charges once', async () => {
    const c = await checkout()
    c.provider.fault({ kind: 'fail', status: 503 }, { kind: 'fail', status: 503 })

    expect((await pay(c, 'o-1')).status).toBe(201)
    expect(c.provider.requests.get('key-o-1')).toBe(3)
    expect([...c.provider.ledger.values()].filter(entry => entry.status === 'charged')).toHaveLength(1)
    expectMoneyInvariants(c)
  })

  // The worst case for a retry: the first attempt charged, its answer is late, and the next attempt overlaps it.
  // The provider sees the key still processing, answers 409, and the retry ends on the original charge.
  it('ends on the original charge when an attempt times out while the provider is still charging', async () => {
    const c = await checkout({ processing: 300 })

    const answer = await pay(c, 'o-1')

    expect(answer.status).toBe(201)
    expect(c.provider.requests.get('key-o-1')).toBeGreaterThanOrEqual(2)
    expect([...c.provider.ledger.values()].filter(entry => entry.status === 'charged')).toHaveLength(1)
    expect(answer.body.chargeId).toBe(c.provider.ledger.get('key-o-1')?.chargeId)
    expectMoneyInvariants(c)
  })

  it('defers checkouts while the breaker is open, sends the provider nothing, and charges each once after', async () => {
    const c = await checkout()
    c.proxy.refuse()
    c.proxy.dropConnections()

    const first = await pay(c, 'o-1')
    expect(first.status).toBe(503)
    expect(c.registry.circuitBreaker('payments').state).toBe('open')

    const deferred = await Promise.all(['o-2', 'o-3', 'o-4'].map(id => pay(c, id)))
    expect(deferred.map(answer => answer.status)).toEqual([202, 202, 202])
    expect(c.provider.requests.size).toBe(0)
    expect([...c.book.orders.values()].filter(order => order.status === 'paid')).toEqual([])

    c.proxy.accept()
    await reconcile(c)

    expect([...c.book.orders.values()].map(order => order.status)).toEqual(['paid', 'paid', 'paid', 'paid'])
    expectMoneyInvariants(c)
  })

  // A timeout leaves the outcome unknown: reporting it as failed would invite the shopper to pay again for a charge
  // that went through. The order stays unknown until the provider says.
  it('reports a charge whose every answer was lost as unknown, never failed, and settles it from the provider', async () => {
    const c = await checkout()
    c.proxy.hold()

    const answer = await pay(c, 'o-1')

    expect(answer.status).toBe(504)
    expect(c.book.orders.get('o-1')?.status).toBe('unknown')
    await c.provider.charged(1)
    c.proxy.release()
    await reconcile(c)

    expect(c.book.orders.get('o-1')?.status).toBe('paid')
    expect([...c.provider.ledger.values()].filter(entry => entry.status === 'charged')).toHaveLength(1)
    expectMoneyInvariants(c)
  })

  it('holds a slow provider to the bulkhead and never past its quota, under 100 concurrent checkouts', async () => {
    const c = await checkout({ processing: 50 })

    const answers = await Promise.all(Array.from({ length: 100 }, (_, i) => pay(c, `o-${i}`)))

    expect(c.provider.peakInFlight).toBeLessThanOrEqual(10)
    expect(c.provider.tooManyRequests).toBe(0)
    expect(answers.every(answer => [201, 202, 503, 504].includes(answer.status))).toBe(true)
    for (const [i, answer] of answers.entries()) {
      if (answer.status === 202) {
        expect(c.provider.requests.get(`key-o-${i}`) ?? 0, `deferred o-${i} reached the provider`).toBe(0)
      }
    }
    await reconcile(c)
    expectMoneyInvariants(c)
  })

  it('does not cancel a charge when the shopper disconnects, and answers the shopper’s retry from it', async () => {
    const c = await checkout()
    c.provider.fault({ kind: 'chargeThenDelay', delay: 100 })
    const browser = new AbortController()

    const leaving = fetch(`${c.app.origin}/checkout/o-1/payment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'key-o-1' },
      body: JSON.stringify({ card: '4242' }),
      signal: browser.signal,
    }).catch(() => undefined)
    await c.provider.charged(1)
    browser.abort()
    await leaving
    await expect.poll(() => c.book.orders.get('o-1')?.status, { timeout: 5_000 }).toBe('paid')

    const again = await pay(c, 'o-1')
    expect(again.status).toBe(201)
    expect(again.body.chargeId).toBe(c.provider.ledger.get('key-o-1')?.chargeId)
    expect([...c.provider.ledger.values()].filter(entry => entry.status === 'charged')).toHaveLength(1)
    expectMoneyInvariants(c)
  })

  it('charges once for a double submit with one key', async () => {
    const c = await checkout({ processing: 50 })

    const [first, second] = await Promise.all([pay(c, 'o-1'), pay(c, 'o-1')])

    expect([first.status, second.status]).toEqual([201, 201])
    expect(first.body.chargeId).toBe(second.body.chargeId)
    expect([...c.provider.ledger.values()].filter(entry => entry.status === 'charged')).toHaveLength(1)
    expectMoneyInvariants(c)
  })

  // A retry outside a transaction must give each attempt a transaction of its own: the failed one rolls back.
  it('records the payment once when the ledger write fails once inside its unit of work', async () => {
    const c = await checkout()
    c.container.get(LedgerRepository).failNext = 1

    expect((await pay(c, 'o-1')).status).toBe(201)

    expect(journal.rollbacks).toBe(1)
    expect(journal.commits).toBe(1)
    expect(journal.entries).toEqual([{ orderId: 'o-1', chargeId: c.provider.ledger.get('key-o-1')?.chargeId }])
    expectMoneyInvariants(c)
  })

  // Every outage a provider has, at once, on a seeded schedule: whatever the order of events, money must add up.
  it('keeps the money invariants through a chaotic run of 120 checkouts', async () => {
    const seed = Number(process.env.RESILIENCE_CHAOS_SEED ?? Math.floor(Math.random() * 2 ** 31))
    const random = mulberry32(seed)
    const c = await checkout({ processing: 20 })
    const moods = [
      () => c.proxy.accept(),
      () => c.proxy.hold(),
      () => {
        c.proxy.release()
        c.proxy.dropConnections()
      },
      () => {
        c.proxy.refuse()
        c.proxy.dropConnections()
      },
    ]
    let chaos = true
    const schedule = (async () => {
      while (chaos) {
        moods[Math.floor(random() * moods.length)]!()
        await new Promise(resolve => setTimeout(resolve, 100 + random() * 150))
      }
    })()

    const answers: Answer[] = []
    for (let batch = 0; batch < 6; batch++) {
      const ids = Array.from({ length: 20 }, (_, i) => `o-${batch * 20 + i}`)
      answers.push(...(await Promise.all(ids.map(id => pay(c, id, random() < 0.2 ? 'declined' : '4242')))))
    }
    chaos = false
    await schedule
    c.proxy.release()
    c.proxy.accept()
    await reconcile(c)

    const context = `seed ${seed}:`
    expect(
      answers.filter(answer => ![201, 202, 402, 503, 504].includes(answer.status)).map(answer => answer.status),
      `${context} unexpected statuses`,
    ).toEqual([])
    expect(c.provider.tooManyRequests, `${context} provider quota exceeded`).toBe(0)
    expectMoneyInvariants(c, context)
  })
})

describe('the replay check on a money route', { timeout: 30_000 }, () => {
  @Controller('/unsafe')
  @Profile('e2e-resilience-payments-unsafe')
  class UnsafeCheckoutController {
    @Retry('orders')
    @Post('/:orderId/payment', p => [p.param('orderId')])
    async pay(orderId: string): Promise<string> {
      return orderId
    }
  }
  void UnsafeCheckoutController

  it('refuses to start an application whose payment POST handler carries @Retry', async () => {
    const error = await startApp(a => a.install(Resilience(r => r.retry('orders'))).install(ResilienceHTTP()), {
      container: new CaffeineIoC({ profiles: ['e2e-resilience-payments-unsafe'] }),
    }).then(
      running => {
        cleanups.push(() => running.close())
        return undefined
      },
      (reason: unknown) => reason as Error,
    )

    expect(error?.message).toContain(
      'Cannot retry "POST /unsafe/:orderId/payment" (UnsafeCheckoutController.pay): POST is not a retryable method',
    )
  })

  const payments = new Map<string, { id: string }>()
  let attempts = 0

  @Controller('/upsert')
  @Profile('e2e-resilience-payments-upsert')
  class UpsertCheckoutController {
    // Repeatable because it upserts by the key: a second attempt finds what the first one wrote.
    @Retry('orders', { repeatable: true })
    @Post('/', p => [p.header('idempotency-key')])
    async pay(key: string): Promise<{ id: string }> {
      attempts++
      let payment = payments.get(key)
      if (payment === undefined) {
        payment = { id: `pay-${payments.size + 1}` }
        payments.set(key, payment)
      }
      if (attempts === 1) {
        throw new Error('connection reset after the write')
      }
      return payment
    }
  }
  void UpsertCheckoutController

  it('retries a repeatable POST that upserts by its key, leaving one payment', async () => {
    const running = await startApp(
      a => a.install(Resilience(r => r.retry('orders', { maxAttempts: 2, backoff: 0 }))).install(ResilienceHTTP()),
      { container: new CaffeineIoC({ profiles: ['e2e-resilience-payments-upsert'] }) },
    )
    cleanups.push(() => running.close())

    const res = await fetch(`${running.origin}/upsert`, { method: 'POST', headers: { 'idempotency-key': 'k-1' } })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'pay-1' })
    expect(attempts).toBe(2)
    expect(payments.size).toBe(1)
  })
})

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}
