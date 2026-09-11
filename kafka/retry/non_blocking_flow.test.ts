import { createApplication } from '@caffeinejs/std'
import { describe, expect, it } from 'vitest'

import { deferred, FakeBroker } from '../broker.testkit.js'
import { KafkaHandler } from '../decorators/kafka_handler.js'
import { KafkaListener } from '../decorators/kafka_listener.js'
import { KafkaRetry } from '../decorators/kafka_retry.js'
import { kafka } from '../plugin.js'
import { KafkaTemplate } from '../template.js'
import { retryTopics } from './strategy.js'

class ErrBoom extends Error {
  override name = 'ErrBoom'
}

const GROUP = 'nb-group'

// Fails twice, then succeeds — proves a record walks the retry topics in-process without blocking the main topic.
let flowState: { attempts: number; done: ReturnType<typeof deferred<number>> }

@KafkaHandler()
class FlowConsumer {
  @KafkaListener({ topic: 'flow' })
  @KafkaRetry(retryTopics({ attempts: 3, backoff: { type: 'fixed', delay: 10 } }))
  onEvent(): void {
    flowState.attempts++
    if (flowState.attempts < 3) {
      throw new ErrBoom(`fail ${flowState.attempts}`)
    }
    flowState.done.resolve(flowState.attempts)
  }
}

// Always fails — proves exhaustion dead-letters with the journey headers.
let poisonSeen: ReturnType<typeof deferred<number>>

@KafkaHandler()
class PoisonConsumer {
  @KafkaListener({ topic: 'poison' })
  @KafkaRetry(retryTopics({ attempts: 2, backoff: { type: 'fixed', delay: 5 } }))
  onEvent(): void {
    poisonSeen.resolve(1)
    throw new ErrBoom('always')
  }
}

describe('non-blocking retry topics (end to end)', () => {
  it('walks a failing record through the retry topics until it succeeds', async () => {
    flowState = { attempts: 0, done: deferred() }
    const broker = new FakeBroker()
    const app = createApplication({}).extend(kafka(k => k.brokers('b').groupId(GROUP), { clients: broker.clients() }))
    const built = app.build()
    await built.run()

    await built.container.get<KafkaTemplate>(KafkaTemplate).send('flow', { x: 1 })

    expect(await flowState.done.promise).toBe(3)
    // The record was forwarded through both retry tiers, not retried in place on the main topic.
    expect(broker.sent.some(message => message.topic === 'flow-retry-0')).toBe(true)
    expect(broker.sent.some(message => message.topic === 'flow-retry-1')).toBe(true)

    await built.close()
  })

  it('dead-letters a poison record after exhausting the retry topics', async () => {
    poisonSeen = deferred()
    const dltReceived = deferred<Record<string, string>>()
    const broker = new FakeBroker()
    const app = createApplication({}).extend(
      kafka(k => k.brokers('b').groupId(GROUP).deadLetter(), { clients: broker.clients() }),
    )
    const built = app.build()
    await built.run()

    await built.container.get<KafkaTemplate>(KafkaTemplate).send('poison', { x: 1 })
    await poisonSeen.promise

    // Wait for the DLT publish (after the last retry tier fails).
    const deadline = Date.now() + 5000
    let dlt: Record<string, string> | undefined
    while (dlt === undefined && Date.now() < deadline) {
      const message = broker.sent.find(m => m.topic === 'poison.DLT')
      if (message !== undefined) {
        dlt = message.headers as Record<string, string>
        dltReceived.resolve(dlt)
      } else {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }

    const headers = await dltReceived.promise
    expect(headers['x-exception-class']).toBe('ErrBoom')
    expect(headers['x-original-topic']).toBe('poison')

    await built.close()
  })
})
