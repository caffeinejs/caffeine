import { describe, expect, it } from 'vitest'

import { FakeBroker } from '../broker.testkit.js'
import { defaultDeserializers, defaultSerializers } from '../clients.js'
import { resolveConfig } from '../config.js'
import type { KafkaRuntime } from '../runtime.js'
import { KafkaTemplate } from '../template.js'
import { deadLetterManager } from './dead_letter_manager.js'

function runtimeFor(broker: FakeBroker): KafkaRuntime {
  const config = resolveConfig(
    { brokers: 'b', groupId: 'g' },
    { serializers: defaultSerializers, deserializers: defaultDeserializers },
  )
  return { name: 'default', container: {} as never, config, clients: broker.clients() }
}

describe('deadLetterManager', () => {
  it('lists dead-letter records without committing them', async () => {
    const broker = new FakeBroker()
    const runtime = runtimeFor(broker)
    const template = new KafkaTemplate(runtime)
    await template.sendMessage({
      topic: 'orders.DLT',
      key: 'k1',
      value: { x: 1 },
      headers: { 'x-original-topic': 'orders', 'x-exception-class': 'ErrBoom', 'x-exception-message': 'boom' },
    })

    const manager = deadLetterManager(runtime, template, { idleTimeout: 40 })
    const records = await manager.list('orders.DLT')

    expect(records).toHaveLength(1)
    expect(records[0].value).toEqual({ x: 1 })
    expect(records[0].error).toEqual({ class: 'ErrBoom', message: 'boom' })
    expect(records[0].headers.get('x-original-topic')).toBe('orders')
    // A peek never advances offsets.
    expect(broker.committed).toHaveLength(0)
  })

  it('re-injects records into the retry chain stamping x-reprocessed-at', async () => {
    const broker = new FakeBroker()
    const runtime = runtimeFor(broker)
    const template = new KafkaTemplate(runtime)
    await template.sendMessage({
      topic: 'orders.DLT',
      key: 'k1',
      value: { x: 1 },
      headers: { 'x-original-topic': 'orders' },
    })

    const manager = deadLetterManager(runtime, template, { idleTimeout: 40 })
    const count = await manager.reprocess('orders.DLT')

    expect(count).toBe(1)
    const reinjected = broker.sent.find(message => message.topic === 'orders-retry-0')
    expect(reinjected).toBeDefined()
    const headers = reinjected?.headers as Record<string, string>
    expect(headers['x-original-topic']).toBe('orders')
    expect(headers['x-reprocessed-at']).toBeDefined()
  })

  it('re-injects to a custom target topic', async () => {
    const broker = new FakeBroker()
    const runtime = runtimeFor(broker)
    const template = new KafkaTemplate(runtime)
    await template.sendMessage({ topic: 'orders.DLT', value: { x: 1 }, headers: { 'x-original-topic': 'orders' } })

    const manager = deadLetterManager(runtime, template, { idleTimeout: 40 })
    await manager.reprocess('orders.DLT', { to: 'orders' })

    expect(broker.sent.some(message => message.topic === 'orders')).toBe(true)
  })

  it('purges by deleting and recreating the topic', async () => {
    const broker = new FakeBroker()
    const runtime = runtimeFor(broker)
    const template = new KafkaTemplate(runtime)
    await template.sendMessage({ topic: 'orders.DLT', value: { x: 1 }, headers: {} })

    const manager = deadLetterManager(runtime, template, { idleTimeout: 40 })
    const drained = await manager.purge('orders.DLT')

    expect(drained).toBe(1)
    expect(broker.deletedTopics).toContain('orders.DLT')
    expect(broker.createdTopics.some(spec => spec.topic === 'orders.DLT')).toBe(true)
  })
})
