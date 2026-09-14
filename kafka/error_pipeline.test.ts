import { createApplication } from '@caffeinejs/std'
import { describe, expect, it } from 'vitest'

import { deferred, FakeBroker } from './broker.testkit.js'
import type { KafkaMessage } from './config.js'
import { KafkaContext } from './context.js'
import { KafkaHandler } from './decorators/kafka_handler.js'
import { KafkaListener } from './decorators/kafka_listener.js'
import { KafkaParams } from './decorators/kafka_params.js'
import { kafka } from './plugin.js'
import { KafkaTemplate } from './template.js'

const GROUP = 'ep-group'

class ErrTransient extends Error {
  override name = 'ErrTransient'
}
class ErrPoison extends Error {
  override name = 'ErrPoison'
}

// --- handlers (module scope; state assigned per test before producing) --------------------------------------

let retryState: { attempts: number; done: ReturnType<typeof deferred<number>> }

@KafkaHandler()
class RetryConsumer {
  @KafkaListener({ topic: 'ep-retry' })
  onEvent(): void {
    retryState.attempts++
    if (retryState.attempts < 3) {
      throw new ErrTransient(`fail ${retryState.attempts}`)
    }
    retryState.done.resolve(retryState.attempts)
  }
}

let poisonState: { attempts: number; error: unknown }

@KafkaHandler()
class PoisonConsumer {
  @KafkaListener({ topic: 'ep-poison' })
  onEvent(): void {
    poisonState.attempts++
    throw new ErrTransient('always')
  }
}

let dltReceived: ReturnType<typeof deferred<KafkaMessage>>

@KafkaHandler()
class DltSink {
  @KafkaListener({ topic: 'ep-poison.DLT' })
  onEvent(message: KafkaMessage): void {
    dltReceived.resolve(message)
  }
}

let notRetryState: { attempts: number; onError: ReturnType<typeof deferred<unknown>> }

@KafkaHandler()
class NotRetryableConsumer {
  @KafkaListener({ topic: 'ep-notretry' })
  onEvent(): void {
    notRetryState.attempts++
    throw new ErrPoison('bad data')
  }
}

let manualDone: ReturnType<typeof deferred<void>>

@KafkaHandler()
class ManualAckConsumer {
  @KafkaListener({ topic: 'ep-manual' })
  @KafkaParams(k => [k.context()])
  async onEvent(ctx: KafkaContext): Promise<void> {
    await ctx.ack()
    manualDone.resolve()
  }
}

let nackState: { attempts: number; done: ReturnType<typeof deferred<number>> }

@KafkaHandler()
class NackConsumer {
  @KafkaListener({ topic: 'ep-nack' })
  @KafkaParams(k => [k.context()])
  onEvent(ctx: KafkaContext): void {
    nackState.attempts++
    if (nackState.attempts < 2) {
      ctx.nack(1)
      return
    }
    nackState.done.resolve(nackState.attempts)
  }
}

describe('error pipeline', () => {
  it('retries a retryable failure until it succeeds', async () => {
    retryState = { attempts: 0, done: deferred() }
    const broker = new FakeBroker()
    const app = createApplication({}).with(
      kafka(
        k =>
          k
            .brokers('b')
            .groupId(GROUP)
            .retry({ attempts: 3, backoff: { type: 'fixed', delay: 1 } }),
        { clients: broker.clients() },
      ),
    )
    const built = app.build()
    await built.run()

    await built.container.get<KafkaTemplate>(KafkaTemplate).send('ep-retry', { x: 1 })
    expect(await retryState.done.promise).toBe(3)

    await built.close()
  })

  it('dead-letters a poison message after retries are exhausted', async () => {
    poisonState = { attempts: 0, error: undefined }
    dltReceived = deferred()
    const observed = deferred<unknown>()
    const broker = new FakeBroker()
    const app = createApplication({}).with(
      kafka(
        k =>
          k
            .brokers('b')
            .groupId(GROUP)
            .retry({ attempts: 2, backoff: { type: 'fixed', delay: 1 } })
            .deadLetter()
            .onError(error => observed.resolve(error)),
        { clients: broker.clients() },
      ),
    )
    const built = app.build()
    await built.run()

    await built.container.get<KafkaTemplate>(KafkaTemplate).send('ep-poison', { x: 1 })

    const dlt = await dltReceived.promise
    expect(poisonState.attempts).toBe(2)
    expect(dlt.topic).toBe('ep-poison.DLT')
    expect(dlt.headers.get('x-exception-class')).toBe('ErrTransient')
    expect(dlt.headers.get('x-original-topic')).toBe('ep-poison')
    expect(await observed.promise).toBeInstanceOf(ErrTransient)

    await built.close()
  })

  it('does not retry a not-retryable exception', async () => {
    notRetryState = { attempts: 0, onError: deferred() }
    const broker = new FakeBroker()
    const app = createApplication({}).with(
      kafka(
        k =>
          k
            .brokers('b')
            .groupId(GROUP)
            .retry({ attempts: 5, backoff: { type: 'fixed', delay: 1 } })
            .notRetryable(ErrPoison)
            .onError(error => notRetryState.onError.resolve(error)),
        { clients: broker.clients() },
      ),
    )
    const built = app.build()
    await built.run()

    await built.container.get<KafkaTemplate>(KafkaTemplate).send('ep-notretry', { x: 1 })

    expect(await notRetryState.onError.promise).toBeInstanceOf(ErrPoison)
    expect(notRetryState.attempts).toBe(1)

    await built.close()
  })

  it('commits after each success in record ack mode', async () => {
    retryState = { attempts: 0, done: deferred() }
    const broker = new FakeBroker()
    const app = createApplication({}).with(
      kafka(
        k =>
          k
            .brokers('b')
            .groupId(GROUP)
            .ackMode('record')
            .retry({ attempts: 3, backoff: { type: 'fixed', delay: 1 } }),
        { clients: broker.clients() },
      ),
    )
    const built = app.build()
    await built.run()

    await built.container.get<KafkaTemplate>(KafkaTemplate).send('ep-retry', { x: 1 })
    await retryState.done.promise
    // the commit runs after the handler returns; let that microtask/timer settle
    await new Promise(resolve => setTimeout(resolve, 20))

    // committed once, only after the 3rd (successful) attempt
    expect(broker.committed.filter(m => m.topic === 'ep-retry')).toHaveLength(1)

    await built.close()
  })

  it('commits when the handler calls ctx.ack() in manual mode', async () => {
    manualDone = deferred()
    const broker = new FakeBroker()
    const app = createApplication({}).with(
      kafka(k => k.brokers('b').groupId(GROUP).ackMode('manual'), { clients: broker.clients() }),
    )
    const built = app.build()
    await built.run()

    await built.container.get<KafkaTemplate>(KafkaTemplate).send('ep-manual', { x: 1 })
    await manualDone.promise

    expect(broker.committed.filter(m => m.topic === 'ep-manual')).toHaveLength(1)

    await built.close()
  })

  it('re-delivers in-process on ctx.nack()', async () => {
    nackState = { attempts: 0, done: deferred() }
    const broker = new FakeBroker()
    const app = createApplication({}).with(
      kafka(
        k =>
          k
            .brokers('b')
            .groupId(GROUP)
            .ackMode('manual')
            .retry({ attempts: 3, backoff: { type: 'fixed', delay: 1 } }),
        { clients: broker.clients() },
      ),
    )
    const built = app.build()
    await built.run()

    await built.container.get<KafkaTemplate>(KafkaTemplate).send('ep-nack', { x: 1 })
    expect(await nackState.done.promise).toBe(2)

    await built.close()
  })
})
