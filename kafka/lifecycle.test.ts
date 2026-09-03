import { createApplication } from '@caffeinejs/std'
import { describe, expect, it } from 'vitest'

import { FakeBroker } from './broker.testkit.js'
import type { KafkaConsumerEventPayload } from './config.js'
import { KafkaHandler } from './decorators/kafka_handler.js'
import { KafkaListener } from './decorators/kafka_listener.js'
import { KafkaListenerContainer } from './listener_container.js'
import { kafka } from './plugin.js'
import { containerKey } from './symbols.js'

@KafkaHandler()
class LifecycleConsumer {
  @KafkaListener({ topic: 'lc-topic' })
  onEvent(): void {}
}

describe('consumer lifecycle events + status', () => {
  it('re-emits normalized events and tracks status', async () => {
    const broker = new FakeBroker()
    const app = createApplication({}).extend(kafka.with({ clients: broker.clients() }), k =>
      k.brokers('b').groupId('lc-group'),
    )
    const built = app.build()
    await built.run()

    const engine = built.container.get<KafkaListenerContainer>(containerKey('default'))
    expect(engine.status()).toBe('running')

    const events: KafkaConsumerEventPayload[] = []
    engine.on('rebalance', payload => events.push(payload))

    broker.fireEvent('rebalance', 'lc-group')
    expect(engine.status()).toBe('rebalancing')
    expect(events).toHaveLength(1)
    expect(events[0].groupId).toBe('lc-group')

    broker.fireEvent('join', 'lc-group')
    expect(engine.status()).toBe('running')

    await built.close()
    expect(engine.status()).toBe('stopped')
  })
})
