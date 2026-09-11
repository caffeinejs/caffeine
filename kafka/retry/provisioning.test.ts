import { createApplication } from '@caffeinejs/std'
import { describe, expect, it } from 'vitest'

import { FakeBroker } from '../broker.testkit.js'
import { KafkaHandler } from '../decorators/kafka_handler.js'
import { KafkaListener } from '../decorators/kafka_listener.js'
import { KafkaRetry } from '../decorators/kafka_retry.js'
import { kafka } from '../plugin.js'
import { retryTopics } from './strategy.js'

@KafkaHandler()
class ProvConsumer {
  @KafkaListener({ topic: 'prov' })
  @KafkaRetry(retryTopics({ attempts: 3, backoff: { type: 'fixed', delay: 5 } }))
  onEvent(): void {}
}

// A listener whose strategy pins the retry-topic partition count explicitly (highest precedence).
@KafkaHandler()
class ExplicitConsumer {
  @KafkaListener({ topic: 'provx' })
  @KafkaRetry(retryTopics({ attempts: 2, backoff: { type: 'fixed', delay: 5 } }, { partitions: 4 }))
  onEvent(): void {}
}

function partitionsOf(broker: FakeBroker, topic: string): number | undefined {
  return broker.createdTopics.find(spec => spec.topic === topic)?.partitions
}

describe('retry topic provisioning', () => {
  it('auto-creates the retry + dead-letter topics and opens an isolated retry consumer', async () => {
    const broker = new FakeBroker()
    const app = createApplication({}).extend(
      kafka(k => k.brokers('b').groupId('g').topicProvisioning({ partitions: 3, replicas: 1 }), {
        clients: broker.clients(),
      }),
    )
    const built = app.build()
    await built.run()

    const created = broker.createdTopics.map(spec => spec.topic)
    expect(created).toContain('prov-retry-0')
    expect(created).toContain('prov-retry-1')
    expect(created).toContain('prov.DLT')
    expect(partitionsOf(broker, 'prov-retry-0')).toBe(3)

    // One consumer for the main topic, one for the retry topics (isolation).
    const retryStream = broker.streams.find(stream => stream.topics.has('prov-retry-0'))
    expect(retryStream).toBeDefined()
    expect(retryStream?.topics.has('prov-retry-1')).toBe(true)
    expect(retryStream?.topics.has('prov')).toBe(false)

    await built.close()
  })

  it('inherits the source topic partition count when none is configured', async () => {
    const broker = new FakeBroker({ partitions: { prov: 6 } })
    const app = createApplication({}).extend(kafka(k => k.brokers('b').groupId('g'), { clients: broker.clients() }))
    const built = app.build()
    await built.run()

    // Retry tiers AND the DLT match the source's 6 partitions.
    expect(partitionsOf(broker, 'prov-retry-0')).toBe(6)
    expect(partitionsOf(broker, 'prov-retry-1')).toBe(6)
    expect(partitionsOf(broker, 'prov.DLT')).toBe(6)

    await built.close()
  })

  it('lets an instance-configured partition count override inheritance', async () => {
    const broker = new FakeBroker({ partitions: { prov: 6 } })
    const app = createApplication({}).extend(
      kafka(k => k.brokers('b').groupId('g').topicProvisioning({ partitions: 2 }), { clients: broker.clients() }),
    )
    const built = app.build()
    await built.run()

    expect(partitionsOf(broker, 'prov-retry-0')).toBe(2)
    expect(partitionsOf(broker, 'prov.DLT')).toBe(2)

    await built.close()
  })

  it('lets a strategy-explicit partition count win over the source and config', async () => {
    const broker = new FakeBroker({ partitions: { provx: 6 } })
    const app = createApplication({}).extend(
      kafka(k => k.brokers('b').groupId('g').topicProvisioning({ partitions: 2 }), { clients: broker.clients() }),
    )
    const built = app.build()
    await built.run()

    // Strategy pinned 4; neither the source (6) nor the instance config (2) applies to its retry topics.
    expect(partitionsOf(broker, 'provx-retry-0')).toBe(4)

    await built.close()
  })

  it('falls back to a single partition when the source is unknown and nothing is configured', async () => {
    const broker = new FakeBroker()
    const app = createApplication({}).extend(kafka(k => k.brokers('b').groupId('g'), { clients: broker.clients() }))
    const built = app.build()
    await built.run()

    expect(partitionsOf(broker, 'prov-retry-0')).toBe(1)

    await built.close()
  })

  it('skips provisioning when autoCreate is false', async () => {
    const broker = new FakeBroker()
    const app = createApplication({}).extend(
      kafka(k => k.brokers('b').groupId('g').topicProvisioning({ autoCreate: false }), { clients: broker.clients() }),
    )
    const built = app.build()
    await built.run()

    expect(broker.createdTopics).toHaveLength(0)

    await built.close()
  })
})
