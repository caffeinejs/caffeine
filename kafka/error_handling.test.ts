import { describe, expect, it, vi } from 'vitest'
import type { KafkaMessage } from './config.js'
import { buildClassifier, deadLetterRecoverer, delayFor } from './error_handling.js'
import type { KafkaTemplate } from './template.js'

class ErrBad extends Error {
  override name = 'ErrBad'
}
class ErrTransient extends Error {
  override name = 'ErrTransient'
}

function fakeMessage(): KafkaMessage {
  return {
    key: 'k1',
    value: { id: 1 },
    topic: 'orders',
    partition: 3,
    offset: 7n,
    timestamp: 0n,
    headers: new Map(),
    metadata: {},
    commit: () => {},
    toJSON: () => ({}) as never,
  }
}

describe('delayFor', () => {
  it('returns a constant delay for fixed backoff', () => {
    const backoff = { type: 'fixed', delay: 250 } as const
    expect(delayFor(backoff, 1)).toBe(250)
    expect(delayFor(backoff, 5)).toBe(250)
  })

  it('doubles (capped) for exponential backoff', () => {
    const backoff = { type: 'exponential', delay: 100, multiplier: 2, max: 500 } as const
    expect(delayFor(backoff, 1)).toBe(100)
    expect(delayFor(backoff, 2)).toBe(200)
    expect(delayFor(backoff, 3)).toBe(400)
    expect(delayFor(backoff, 4)).toBe(500) // capped
  })

  it('is zero without a backoff', () => {
    expect(delayFor(undefined, 3)).toBe(0)
  })
})

describe('buildClassifier', () => {
  it('retries everything by default', () => {
    const classify = buildClassifier({})
    expect(classify(new ErrBad(), 1)).toBe(true)
  })

  it('never retries notRetryable exceptions', () => {
    const classify = buildClassifier({ notRetryable: [ErrBad] })
    expect(classify(new ErrBad(), 1)).toBe(false)
    expect(classify(new ErrTransient(), 1)).toBe(true)
  })

  it('retries only the allowlist when given', () => {
    const classify = buildClassifier({ retryable: [ErrTransient] })
    expect(classify(new ErrTransient(), 1)).toBe(true)
    expect(classify(new ErrBad(), 1)).toBe(false)
  })

  it('honours a custom classifier over the lists', () => {
    const classify = buildClassifier({ notRetryable: [ErrTransient], classifier: () => true })
    expect(classify(new ErrTransient(), 1)).toBe(true)
  })
})

describe('deadLetterRecoverer', () => {
  it('publishes to ${topic}.DLT with exception + provenance headers', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const template = { sendMessage } as unknown as KafkaTemplate
    const recover = deadLetterRecoverer(template)

    await recover(fakeMessage(), new ErrBad('boom'), { attempt: 3, groupId: 'g', instance: 'default' })

    expect(sendMessage).toHaveBeenCalledTimes(1)
    const message = sendMessage.mock.calls[0][0]
    expect(message.topic).toBe('orders.DLT')
    expect(message.key).toBe('k1')
    expect(message.value).toEqual({ id: 1 })
    expect(message.headers['x-exception-class']).toBe('ErrBad')
    expect(message.headers['x-exception-message']).toBe('boom')
    expect(message.headers['x-original-topic']).toBe('orders')
    expect(message.headers['x-original-partition']).toBe('3')
    expect(message.headers['x-original-offset']).toBe('7')
    expect(message.headers['x-attempts']).toBe('3')
  })

  it('supports a custom topic', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const template = { sendMessage } as unknown as KafkaTemplate
    const recover = deadLetterRecoverer(template, { topic: record => `dead.${record.topic}` })

    await recover(fakeMessage(), new Error('x'), { attempt: 1, groupId: 'g', instance: 'default' })

    expect(sendMessage.mock.calls[0][0].topic).toBe('dead.orders')
  })
})
