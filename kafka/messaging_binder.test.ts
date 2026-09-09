import {
  Consume,
  MessageBus,
  type MessageContext,
  MessageHandler,
  MessageParams,
  messaging,
} from '@caffeinejs/messaging'
import { createApplication } from '@caffeinejs/std'
import { describe, expect, it } from 'vitest'

import { deferred, FakeBroker } from './broker.testkit.js'
import { kafkaBinder } from './messaging_binder.js'

let got: ReturnType<typeof deferred<{ id: number }>>

@MessageHandler()
class RoundTrip {
  @Consume('kb-orders')
  on(payload: { id: number }): void {
    got.resolve(payload)
  }
}

let bridged: ReturnType<typeof deferred<{ from: number }>>

@MessageHandler()
class BridgeSource {
  @Consume('kb-orders2')
  @MessageParams(m => [m.payload(), m.context()])
  async on(payload: { id: number }, ctx: MessageContext): Promise<void> {
    await ctx.send('kb-notify', { from: payload.id })
  }
}

@MessageHandler()
class BridgeSink {
  @Consume('kb-notify-in')
  on(payload: { from: number }): void {
    bridged.resolve(payload)
  }
}

let retryState: { attempts: number; done: ReturnType<typeof deferred<number>> }

@MessageHandler()
class RetryHandler {
  @Consume('kb-orders3')
  on(): void {
    retryState.attempts++
    if (retryState.attempts < 3) {
      throw new Error(`transient ${retryState.attempts}`)
    }
    retryState.done.resolve(retryState.attempts)
  }
}

let ackDone: ReturnType<typeof deferred<void>>

@MessageHandler()
class AckHandler {
  @Consume('kb-orders4')
  on(): void {
    ackDone.resolve()
  }
}

let secondGot: ReturnType<typeof deferred<{ id: number }>>

@MessageHandler()
class PumpConsumer {
  @Consume('kb-pump')
  on(payload: { id: number }): void {
    if (payload.id === 1) {
      throw new Error('boom') // drives the failing-recoverer path below
    }
    secondGot.resolve(payload)
  }
}

describe('kafka messaging binder', () => {
  it('consumes a produced record through the messaging engine', async () => {
    got = deferred()
    const broker = new FakeBroker()
    const app = createApplication({}).extend(messaging(), m =>
      m
        .use('kafka', kafkaBinder({ brokers: 'b', groupId: 'g', clients: broker.clients() }))
        .in('kb-orders', { destination: 'orders', via: 'kafka' })
        .out('kb-inject', { destination: 'orders', via: 'kafka' }),
    )
    const built = app.build()
    await built.run()

    await built.container.get<MessageBus>(MessageBus).send('kb-inject', { id: 5 })

    expect(await got.promise).toEqual({ id: 5 })
    await built.close()
  })

  it('bridges two real kafka binder instances in one process', async () => {
    bridged = deferred()
    const brokerA = new FakeBroker()
    const brokerB = new FakeBroker()
    const app = createApplication({}).extend(messaging(), m =>
      m
        .use('a', kafkaBinder({ brokers: 'a', groupId: 'ga', clients: brokerA.clients() }))
        .use('b', kafkaBinder({ brokers: 'b', groupId: 'gb', clients: brokerB.clients() }))
        .in('kb-orders2', { destination: 'orders', via: 'a' })
        .out('kb-inject2', { destination: 'orders', via: 'a' })
        .in('kb-notify-in', { destination: 'notify', via: 'b' })
        .out('kb-notify', { destination: 'notify', via: 'b' }),
    )
    const built = app.build()
    await built.run()

    await built.container.get<MessageBus>(MessageBus).send('kb-inject2', { id: 7 })

    expect(await bridged.promise).toEqual({ from: 7 })
    await built.close()
  })

  it('retries a failing handler with the binding blocking-retry policy', async () => {
    retryState = { attempts: 0, done: deferred() }
    const broker = new FakeBroker()
    const app = createApplication({}).extend(messaging(), m =>
      m
        .use('kafka', kafkaBinder({ brokers: 'b', groupId: 'g', clients: broker.clients() }))
        .in('kb-orders3', {
          destination: 'orders',
          via: 'kafka',
          retry: { attempts: 3, backoff: { type: 'fixed', delay: 1 } },
        })
        .out('kb-inject3', { destination: 'orders', via: 'kafka' }),
    )
    const built = app.build()
    await built.run()

    await built.container.get<MessageBus>(MessageBus).send('kb-inject3', { id: 1 })

    expect(await retryState.done.promise).toBe(3)
    await built.close()
  })

  it('commits after success in record ack mode', async () => {
    ackDone = deferred()
    const broker = new FakeBroker()
    const app = createApplication({}).extend(messaging(), m =>
      m
        .use('kafka', kafkaBinder({ brokers: 'b', groupId: 'g', ackMode: 'record', clients: broker.clients() }))
        .in('kb-orders4', { destination: 'orders', via: 'kafka' })
        .out('kb-inject4', { destination: 'orders', via: 'kafka' }),
    )
    const built = app.build()
    await built.run()

    await built.container.get<MessageBus>(MessageBus).send('kb-inject4', { id: 1 })
    await ackDone.promise
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(broker.committed.filter(m => m.topic === 'orders')).toHaveLength(1)
    await built.close()
  })

  it('keeps the consumer alive when dispatch throws (a failing recoverer does not kill the pump)', async () => {
    secondGot = deferred()
    const pumpErr = deferred<unknown>()
    const broker = new FakeBroker()
    const app = createApplication({}).extend(messaging(), m =>
      m
        .use(
          'kafka',
          kafkaBinder({ brokers: 'b', groupId: 'g', clients: broker.clients(), onError: e => pumpErr.resolve(e) }),
        )
        .recoverer(() => {
          throw new Error('recoverer failed')
        })
        .in('kb-pump', { destination: 'pump', via: 'kafka' })
        .out('kb-pump-in', { destination: 'pump', via: 'kafka' }),
    )
    const built = app.build()
    await built.run()
    const bus = built.container.get<MessageBus>(MessageBus)

    // id:1 fails -> recover -> recoverer throws -> pump's onError fires but the consumer must survive
    await bus.send('kb-pump-in', { id: 1 })
    await pumpErr.promise

    // id:2 must still be delivered — proves the pump did not die on the infra error
    await bus.send('kb-pump-in', { id: 2 })
    expect(await secondGot.promise).toEqual({ id: 2 })
    await built.close()
  })
})
