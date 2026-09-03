import { describe, expect, it } from 'vitest'

import type { KafkaMessage } from '../config.js'
import { blockingRetry, type RetryDelivery, retryTopics, sharedRetryTopic } from './strategy.js'

class ErrBoom extends Error {
  override name = 'ErrBoom'
}

// A behavior that always throws — keeps the `throw` off the call site (one statement per line).
function throwing(message: string): () => never {
  return () => {
    throw new ErrBoom(message)
  }
}

interface Script {
  /** Runs on each `invoke`, given the current attempt; throw to fail, set `nack` to nack. */
  behavior: (attempt: number) => void
  classify?: (error: unknown, attempt: number) => boolean
  initialAttempt?: number
}

// A scripted RetryDelivery recording every primitive a strategy drives, for asserting control flow.
class FakeDelivery implements RetryDelivery {
  readonly message = {} as KafkaMessage
  readonly sourceTopic = 'orders'
  readonly initialAttempt: number
  acked = false
  nacked = false
  nackDelay?: number

  invocations = 0
  currentAttempt = 0
  readonly forwards: Array<{ topic: string; headers?: Record<string, string> }> = []
  readonly recovered: unknown[] = []
  readonly commits: Array<'success' | 'advance'> = []
  slept = false

  readonly #script: Script

  constructor(script: Script) {
    this.#script = script
    this.initialAttempt = script.initialAttempt ?? 1
  }

  reset(attempt: number): void {
    this.currentAttempt = attempt
    this.acked = false
    this.nacked = false
    this.nackDelay = undefined
  }

  invoke(): Promise<void> {
    this.invocations++
    this.#script.behavior(this.currentAttempt)
    return Promise.resolve()
  }

  classify(error: unknown, attempt: number): boolean {
    return this.#script.classify?.(error, attempt) ?? true
  }

  sleepUntilReady(): Promise<void> {
    this.slept = true
    return Promise.resolve()
  }

  forward(topic: string, headers?: Record<string, string>): Promise<void> {
    this.forwards.push({ topic, headers })
    return Promise.resolve()
  }

  recover(error: unknown): Promise<void> {
    this.recovered.push(error)
    return Promise.resolve()
  }

  commitSuccess(): Promise<void> {
    this.commits.push('success')
    return Promise.resolve()
  }

  commitAdvance(): Promise<void> {
    this.commits.push('advance')
    return Promise.resolve()
  }
}

describe('blockingRetry', () => {
  it('re-invokes until the handler succeeds, then commits the success', async () => {
    const delivery = new FakeDelivery({
      behavior: attempt => {
        if (attempt < 3) {
          throw new ErrBoom(`fail ${attempt}`)
        }
      },
    })

    await blockingRetry({ attempts: 3, backoff: { type: 'fixed', delay: 0 } }).dispatch(delivery)

    expect(delivery.invocations).toBe(3)
    expect(delivery.commits).toEqual(['success'])
    expect(delivery.forwards).toHaveLength(0)
    expect(delivery.recovered).toHaveLength(0)
  })

  it('recovers after exhausting the attempts', async () => {
    const delivery = new FakeDelivery({ behavior: throwing('always') })

    await blockingRetry({ attempts: 2, backoff: { type: 'fixed', delay: 0 } }).dispatch(delivery)

    expect(delivery.invocations).toBe(2)
    expect(delivery.recovered).toHaveLength(1)
    expect(delivery.recovered[0]).toBeInstanceOf(ErrBoom)
    expect(delivery.commits).toEqual(['advance'])
  })

  it('goes straight to recovery for a non-retryable error', async () => {
    const delivery = new FakeDelivery({ behavior: throwing('bad'), classify: () => false })

    await blockingRetry({ attempts: 5, backoff: { type: 'fixed', delay: 0 } }).dispatch(delivery)

    expect(delivery.invocations).toBe(1)
    expect(delivery.recovered).toHaveLength(1)
  })

  it('declares no extra topics', () => {
    expect(blockingRetry({ attempts: 3 }).topics('orders')).toEqual([])
  })
})

describe('retryTopics', () => {
  it('declares one topic per level with escalating delays', () => {
    const strategy = retryTopics({ attempts: 4, backoff: { type: 'fixed', delay: 100 } })

    expect(strategy.topics('orders')).toEqual([
      { topic: 'orders-retry-0', delay: 100, partitions: undefined },
      { topic: 'orders-retry-1', delay: 100, partitions: undefined },
      { topic: 'orders-retry-2', delay: 100, partitions: undefined },
    ])
    expect(strategy.deadLetterTopic?.('orders')).toBe('orders.DLT')
  })

  it('forwards a retryable failure to the next retry topic with journey headers', async () => {
    const delivery = new FakeDelivery({ initialAttempt: 1, behavior: throwing('boom') })

    await retryTopics({ attempts: 3, backoff: { type: 'fixed', delay: 50 } }).dispatch(delivery)

    expect(delivery.slept).toBe(true)
    expect(delivery.forwards).toHaveLength(1)
    const [forward] = delivery.forwards
    expect(forward.topic).toBe('orders-retry-0')
    expect(forward.headers?.['x-retry-attempt']).toBe('2')
    expect(forward.headers?.['x-exception-class']).toBe('ErrBoom')
    expect(Number(forward.headers?.['x-retry-not-before'])).toBeGreaterThan(Date.now())
    expect(delivery.commits).toEqual(['advance'])
    expect(delivery.recovered).toHaveLength(0)
  })

  it('dead-letters (recovers) when the last retry level fails', async () => {
    const delivery = new FakeDelivery({ initialAttempt: 3, behavior: throwing('boom') })

    await retryTopics({ attempts: 3, backoff: { type: 'fixed', delay: 50 } }).dispatch(delivery)

    expect(delivery.forwards).toHaveLength(0)
    expect(delivery.recovered).toHaveLength(1)
    expect(delivery.commits).toEqual(['advance'])
  })

  it('commits a success without forwarding', async () => {
    const delivery = new FakeDelivery({ initialAttempt: 2, behavior: () => undefined })

    await retryTopics({ attempts: 3, backoff: { type: 'fixed', delay: 50 } }).dispatch(delivery)

    expect(delivery.commits).toEqual(['success'])
    expect(delivery.forwards).toHaveLength(0)
  })
})

describe('sharedRetryTopic', () => {
  it('declares a single retry topic', () => {
    const strategy = sharedRetryTopic({ attempts: 3, backoff: { type: 'fixed', delay: 10 } })

    expect(strategy.topics('orders')).toEqual([{ topic: 'orders-retry', delay: 0, partitions: undefined }])
  })

  it('forwards back to the one topic incrementing the attempt', async () => {
    const delivery = new FakeDelivery({ initialAttempt: 2, behavior: throwing('boom') })

    await sharedRetryTopic({ attempts: 4, backoff: { type: 'fixed', delay: 5 } }).dispatch(delivery)

    expect(delivery.forwards).toHaveLength(1)
    expect(delivery.forwards[0].topic).toBe('orders-retry')
    expect(delivery.forwards[0].headers?.['x-retry-attempt']).toBe('3')
  })
})
