import { describe, expect, it, vi } from 'vitest'
import type { ConsumerClient, ConsumerStream, KafkaMessage } from './config.js'
import { KafkaContext } from './context.js'
import { kSignals } from './symbols.js'
import { KafkaTemplate } from './template.js'

function fakeMessage(commit: () => void = () => {}): KafkaMessage {
  return {
    key: 'k1',
    value: { id: 7 },
    topic: 'orders',
    partition: 2,
    offset: 42n,
    timestamp: 99n,
    headers: new Map([['h', 'v']]),
    metadata: {},
    commit,
    toJSON: () => ({}) as never,
  }
}

function makeContext(message: KafkaMessage, template: KafkaTemplate): KafkaContext {
  return new KafkaContext({
    message,
    groupId: 'g1',
    instance: 'orders',
    consumer: {} as ConsumerClient,
    stream: {} as ConsumerStream,
    template,
  })
}

describe('KafkaContext', () => {
  it('exposes the record metadata', () => {
    const ctx = makeContext(fakeMessage(), {} as KafkaTemplate)
    expect(ctx.topic).toBe('orders')
    expect(ctx.partition).toBe(2)
    expect(ctx.offset).toBe(42n)
    expect(ctx.key).toBe('k1')
    expect(ctx.value).toEqual({ id: 7 })
    expect(ctx.headers.get('h')).toBe('v')
    expect(ctx.groupId).toBe('g1')
    expect(ctx.instance).toBe('orders')
    expect(ctx.attempt).toBe(1)
  })

  it('ack() commits the message and marks the signal', async () => {
    const commit = vi.fn()
    const ctx = makeContext(fakeMessage(commit), {} as KafkaTemplate)

    await ctx.ack()

    expect(commit).toHaveBeenCalledTimes(1)
    expect(ctx[kSignals].acked).toBe(true)
  })

  it('nack() records the redelivery signal + delay without committing', () => {
    const commit = vi.fn()
    const ctx = makeContext(fakeMessage(commit), {} as KafkaTemplate)

    ctx.nack(1500)

    expect(commit).not.toHaveBeenCalled()
    expect(ctx[kSignals].nacked).toBe(true)
    expect(ctx[kSignals].nackDelay).toBe(1500)
  })

  it('send() proxies the instance template', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const template = { send } as unknown as KafkaTemplate
    const ctx = makeContext(fakeMessage(), template)

    await ctx.send('other', { hi: 1 }, { key: 'kk' })

    expect(send).toHaveBeenCalledWith('other', { hi: 1 }, { key: 'kk' })
  })
})
