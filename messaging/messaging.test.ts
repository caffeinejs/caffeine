import { $t, createApplication } from '@caffeinejs/std'
import type { SchemaIssue } from '@caffeinejs/std/schema'
import { describe, expect, it } from 'vitest'

import { InMemoryBroker, inMemoryBinder } from './binder.testkit.js'
import { MessageBus } from './bus.js'
import type { MessageContext } from './context.js'
import { Consume } from './decorators/consume.js'
import { MessageHandler } from './decorators/message_handler.js'
import { MessageParams } from './decorators/message_params.js'
import { ErrMessageValidation, ErrNoConsumer, ErrUnknownBinder } from './errors.js'
import { message } from './message.js'
import { messaging } from './plugin.js'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}

// --- handlers (module scope; unique binding names keep tests from cross-wiring through the global registry) ---

let received: ReturnType<typeof deferred<{ id: number }>>

@MessageHandler()
class OrdersConsumer {
  @Consume('orders1')
  on(payload: { id: number }): void {
    received.resolve(payload)
  }
}

let bridged: ReturnType<typeof deferred<{ from: number }>>

@MessageHandler()
class BridgeConsumer {
  @Consume('orders2')
  @MessageParams(m => [m.payload(), m.context()])
  async on(payload: { id: number }, ctx: MessageContext): Promise<void> {
    await ctx.send('notify2', { from: payload.id })
  }
}

let picked: ReturnType<typeof deferred<{ trace: unknown; attempt: number; first: unknown }>>

@MessageHandler()
class PickerConsumer {
  @Consume('orders5')
  @MessageParams(m => [m.header('trace'), m.attempt(), m.pick(msg => (msg.payload as { id: number }).id)])
  on(trace: unknown, attempt: number, first: unknown): void {
    picked.resolve({ trace, attempt, first })
  }
}

@MessageHandler()
class NotifySink {
  @Consume('notify2in')
  on(payload: { from: number }): void {
    bridged.resolve(payload)
  }
}

let retryState: { attempts: number; done: ReturnType<typeof deferred<number>> }

@MessageHandler()
class RetryConsumer {
  @Consume('orders3')
  on(): void {
    retryState.attempts++
    if (retryState.attempts < 3) {
      throw new Error('transient')
    }
    retryState.done.resolve(retryState.attempts)
  }
}

let schemaGot: ReturnType<typeof deferred<{ id: number; tag: string }>>

@MessageHandler()
class SchemaConsumer {
  @Consume('orders6')
  on(payload: { id: number; tag: string }): void {
    schemaGot.resolve(payload)
  }
}

@MessageHandler()
class StrictConsumer {
  @Consume('orders7')
  on(): void {
    throw new Error('handler must not run for an invalid payload')
  }
}

@MessageHandler()
class AlwaysFails {
  @Consume('orders8')
  on(): void {
    throw new Error('boom')
  }
}

@MessageHandler()
class Poison {
  @Consume('orders9')
  on(): void {
    throw new Error('poison')
  }
}

let dead: ReturnType<typeof deferred<{ failed: unknown }>>

@MessageHandler()
class DeadSink {
  @Consume('dlt-in')
  on(payload: { failed: unknown }): void {
    dead.resolve(payload)
  }
}

class ErrNonRetryable extends Error {
  override name = 'ErrNonRetryable'
}

let nrState: { attempts: number; recovered: ReturnType<typeof deferred<number>> }

@MessageHandler()
class NonRetryableConsumer {
  @Consume('orders10')
  on(): void {
    nrState.attempts++
    throw new ErrNonRetryable('permanent')
  }
}

describe('messaging', () => {
  it('delivers a published message to its @Consume handler', async () => {
    received = deferred()
    const broker = new InMemoryBroker()
    const app = createApplication({}).with(
      messaging(m => m.use('primary', inMemoryBinder(broker)).in('orders1', { destination: 'orders', via: 'primary' })),
    )
    const built = app
    await built.run()

    broker.publish('orders', message({ id: 42 }))

    expect(await received.promise).toEqual({ id: 42 })
    await built.close()
  })

  it('bridges two binder instances in one process (no binder-kind branching)', async () => {
    bridged = deferred()
    const brokerA = new InMemoryBroker()
    const brokerB = new InMemoryBroker()
    const app = createApplication({}).with(
      messaging(m =>
        m
          .use('a', inMemoryBinder(brokerA))
          .use('b', inMemoryBinder(brokerB))
          .in('orders2', { destination: 'orders', via: 'a' })
          .in('notify2in', { destination: 'notify', via: 'b' })
          .out('notify2', { destination: 'notify', via: 'b' }),
      ),
    )
    const built = app
    await built.run()

    brokerA.publish('orders', message({ id: 7 }))

    expect(await bridged.promise).toEqual({ from: 7 })
    await built.close()
  })

  it('retries a failing handler with the binding blocking-retry policy', async () => {
    retryState = { attempts: 0, done: deferred() }
    const broker = new InMemoryBroker()
    const app = createApplication({}).with(
      messaging(m =>
        m.use('primary', inMemoryBinder(broker)).in('orders3', {
          destination: 'orders',
          via: 'primary',
          retry: { attempts: 3, backoff: { type: 'fixed', delay: 1 } },
        }),
      ),
    )
    const built = app
    await built.run()

    broker.publish('orders', message({ id: 1 }))

    expect(await retryState.done.promise).toBe(3)
    await built.close()
  })

  it('fails fast at run when a binding names an unregistered binder', async () => {
    const app = createApplication({}).with(
      messaging(m => m.use('primary', inMemoryBinder()).in('orders4', { destination: 'orders', via: 'ghost' })),
    )
    const built = app

    await expect(built.run()).rejects.toBeInstanceOf(ErrUnknownBinder)
    await built.close()
  })

  it('publishes through the MessageBus to an outbound binding', async () => {
    const broker = new InMemoryBroker()
    const app = createApplication({}).with(
      messaging(m => m.use('primary', inMemoryBinder(broker)).out('emit', { destination: 'emitted', via: 'primary' })),
    )
    const built = app
    await built.run()

    await built.container.get<MessageBus>(MessageBus).send('emit', { hello: 'world' })

    expect(broker.published.map(p => ({ destination: p.destination, payload: p.message.payload }))).toContainEqual({
      destination: 'emitted',
      payload: { hello: 'world' },
    })
    await built.close()
  })

  it('extracts handler arguments via @MessageParams pickers', async () => {
    picked = deferred()
    const broker = new InMemoryBroker()
    const app = createApplication({}).with(
      messaging(m => m.use('primary', inMemoryBinder(broker)).in('orders5', { destination: 'orders', via: 'primary' })),
    )
    const built = app
    await built.run()

    broker.publish('orders', message({ id: 99 }, { headers: { trace: 'abc' } }))

    expect(await picked.promise).toEqual({ trace: 'abc', attempt: 1, first: 99 })
    await built.close()
  })

  it('validates + coerces an inbound payload against the binding schema', async () => {
    schemaGot = deferred()
    const broker = new InMemoryBroker()
    const app = createApplication({}).with(
      messaging(m =>
        m.use('primary', inMemoryBinder(broker)).in('orders6', {
          destination: 'orders',
          via: 'primary',
          schema: $t.Object({ id: $t.Integer(), tag: $t.String({ default: 'new' }) }),
        }),
      ),
    )
    const built = app
    await built.run()

    // string id coerced to int, missing tag defaulted, undeclared "extra" cleaned away
    broker.publish('orders', message({ id: '42', extra: 'drop' }))

    expect(await schemaGot.promise).toEqual({ id: 42, tag: 'new' })
    await built.close()
  })

  it('skips the handler and fires onInvalidMessage for a bad inbound payload', async () => {
    const invalid = deferred<SchemaIssue[]>()
    const broker = new InMemoryBroker()
    const app = createApplication({}).with(
      messaging(m =>
        m
          .use('primary', inMemoryBinder(broker))
          .onInvalidMessage(issues => invalid.resolve(issues))
          .in('orders7', { destination: 'orders', via: 'primary', schema: $t.Object({ id: $t.Integer() }) }),
      ),
    )
    const built = app
    await built.run()

    broker.publish('orders', message({ id: 'not-a-number' }))

    expect((await invalid.promise).length).toBeGreaterThan(0)
    await built.close()
  })

  it('throws ErrMessageValidation for an invalid outbound payload', async () => {
    const broker = new InMemoryBroker()
    const app = createApplication({}).with(
      messaging(m =>
        m
          .use('primary', inMemoryBinder(broker))
          .out('emit2', { destination: 'emitted', via: 'primary', schema: $t.Object({ id: $t.Integer() }) }),
      ),
    )
    const built = app
    await built.run()

    await expect(built.container.get<MessageBus>(MessageBus).send('emit2', { id: 'bad' })).rejects.toBeInstanceOf(
      ErrMessageValidation,
    )
    await built.close()
  })

  it('fires onError + recoverer when retries are exhausted', async () => {
    const recovered = deferred<{ binder: string; attempt: number; payload: unknown }>()
    const observed = deferred<unknown>()
    const broker = new InMemoryBroker()
    const app = createApplication({}).with(
      messaging(m =>
        m
          .use('primary', inMemoryBinder(broker))
          .onError(error => observed.resolve(error))
          .recoverer((_error, msg, ctx) => {
            recovered.resolve({ binder: ctx.binder, attempt: ctx.attempt, payload: msg.payload })
          })
          .in('orders8', {
            destination: 'orders',
            via: 'primary',
            retry: { attempts: 2, backoff: { type: 'fixed', delay: 1 } },
          }),
      ),
    )
    const built = app
    await built.run()

    broker.publish('orders', message({ id: 1 }))

    expect(await recovered.promise).toEqual({ binder: 'primary', attempt: 2, payload: { id: 1 } })
    expect(await observed.promise).toBeInstanceOf(Error)
    await built.close()
  })

  it('supports a portable dead-letter via a recoverer that bus.sends', async () => {
    dead = deferred()
    const ref: { bus?: MessageBus } = {}
    const broker = new InMemoryBroker()
    const app = createApplication({}).with(
      messaging(m =>
        m
          .use('primary', inMemoryBinder(broker))
          .recoverer(async (_error, msg) => {
            await ref.bus?.send('dlt-out', { failed: msg.payload })
          })
          .in('orders9', { destination: 'orders', via: 'primary' })
          .in('dlt-in', { destination: 'dlt', via: 'primary' })
          .out('dlt-out', { destination: 'dlt', via: 'primary' }),
      ),
    )
    const built = app
    await built.run()
    ref.bus = built.container.get<MessageBus>(MessageBus)

    broker.publish('orders', message({ id: 99 }))

    expect(await dead.promise).toEqual({ failed: { id: 99 } })
    await built.close()
  })

  it('fails fast at run when an inbound binding has no handler', async () => {
    const broker = new InMemoryBroker()
    const app = createApplication({}).with(
      messaging(m =>
        m.use('primary', inMemoryBinder(broker)).in('orphan-binding', { destination: 'orphan', via: 'primary' }),
      ),
    )
    const built = app

    await expect(built.run()).rejects.toBeInstanceOf(ErrNoConsumer)
    await built.close()
  })

  it('does not retry a non-retryable error', async () => {
    nrState = { attempts: 0, recovered: deferred() }
    const broker = new InMemoryBroker()
    const app = createApplication({}).with(
      messaging(m =>
        m
          .use('primary', inMemoryBinder(broker))
          .recoverer(() => nrState.recovered.resolve(nrState.attempts))
          .in('orders10', {
            destination: 'orders',
            via: 'primary',
            notRetryable: [ErrNonRetryable],
            retry: { attempts: 5, backoff: { type: 'fixed', delay: 1 } },
          }),
      ),
    )
    const built = app
    await built.run()

    broker.publish('orders', message({ id: 1 }))

    // attempts:5 would retry, but ErrNonRetryable is classified non-retryable → invoked once, then recovered
    expect(await nrState.recovered.promise).toBe(1)
    await built.close()
  })
})
