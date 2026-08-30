import { describe, expect, it } from 'vitest'
import type { Container } from '@caffeinejs/di'
import { $t, createApplication, kAppConfig } from '@caffeinejs/std'
import { ConfigPriority, EnvConfigProvider, InlineConfigProvider } from '@caffeinejs/std/config'
import type { ConsumerClient, KafkaClients, ProducerClient, ResolvedKafkaConfig } from './config.js'
import { kafka } from './plugin.js'
import { runtimeKey } from './symbols.js'
import type { KafkaRuntime } from './runtime.js'

function noopClients(): KafkaClients {
  const producer: ProducerClient = { send: () => Promise.resolve(), close: () => Promise.resolve() }
  const consumer: ConsumerClient = {
    consume: () => Promise.resolve(Object.assign(
      { async* [Symbol.asyncIterator]() {} },
      { close: () => Promise.resolve() },
    )),
    close: () => Promise.resolve(),
  }
  return { createProducer: () => producer, createConsumer: () => consumer }
}

function configOf(container: Container, instance: string): ResolvedKafkaConfig {
  return (container.get(runtimeKey(instance)) as KafkaRuntime).config
}

const env = (values: Record<string, string>) =>
  new EnvConfigProvider({ env: values })

describe('kafka configuration', () => {
  it('reads brokers from the configuration tree with no builder call at all', async () => {
    const app = createApplication({}).extend(kafka('kafka', { clients: noopClients() }))
    app.config(c => c.source(new InlineConfigProvider({
      kafka: { default: { brokers: ['from-config:9092'], groupId: 'from-config' } },
    })))
    app.kafka(() => undefined)

    const built = app.build()
    await built.ready()

    expect(configOf(built.container, 'default').brokers).toEqual(['from-config:9092'])
    expect(configOf(built.container, 'default').groupId).toBe('from-config')

    await built.close()
  })

  // The regression the whole mechanism exists for: a builder method is a default, not a setting.
  it('lets the environment override a builder-set broker list', async () => {
    const app = createApplication({}).extend(kafka('kafka', { clients: noopClients() }))
    app.config(c => c.source(env({ KAFKA__DEFAULT__BROKERS: 'prod-1:9092,prod-2:9092' }), ConfigPriority.ENV))
    app.kafka(k => k.brokers('localhost:9092').groupId('svc'))

    const built = app.build()
    await built.ready()

    expect(configOf(built.container, 'default').brokers).toEqual(['prod-1:9092', 'prod-2:9092'])
    // Untouched by the environment, so the code value still stands.
    expect(configOf(built.container, 'default').groupId).toBe('svc')

    await built.close()
  })

  it('keeps named instances apart, the unnamed one at kafka.default', async () => {
    const app = createApplication({}).extend(kafka('kafka', { clients: noopClients() }))
    // `GROUP_ID`, not `GROUPID`: the env provider folds underscores *within* a segment into camelCase, so an
    // all-uppercase run has no word boundary to find and `GROUPID` would resolve to `groupid`.
    app.config(c => c.source(env({ KAFKA__ORDERS__GROUP_ID: 'orders-canary' }), ConfigPriority.ENV))
    app.kafka(k => k.brokers('b1:9092').groupId('svc'))
    app.kafka('orders', k => k.brokers('b2:9092').groupId('orders'))

    const built = app.build()
    await built.ready()

    expect(configOf(built.container, 'default').brokers).toEqual(['b1:9092'])
    expect(configOf(built.container, 'default').groupId).toBe('svc')
    expect(configOf(built.container, 'orders').brokers).toEqual(['b2:9092'])
    expect(configOf(built.container, 'orders').groupId).toBe('orders-canary')

    await built.close()
  })

  it('re-points reads and code-set defaults together via .config()', async () => {
    const schema = $t.Object({
      app: $t.Object({
        events: $t.Object({
          brokers: $t.Optional($t.List($t.String())),
          groupId: $t.Optional($t.String()),
        }),
      }),
    })

    const app = createApplication({})
      .extend(kafka('kafka', { clients: noopClients() }))
      .config(schema, c => c.source(new InlineConfigProvider({
        app: { events: { groupId: 'from-moved-path' } },
      })))

    // No annotation on the selector: the config type is recovered from the builder.
    app.kafka(k => k.brokers('moved:9092').config(c => c.app.events))

    const built = app.build()
    await built.ready()

    expect(configOf(built.container, 'default').brokers).toEqual(['moved:9092'])
    expect(configOf(built.container, 'default').groupId).toBe('from-moved-path')
    // Nothing was written at the default namespace.
    const handle = built.container.get(kAppConfig) as Record<string, unknown>
    expect(handle.kafka).toBeUndefined()

    await built.close()
  })

  it('still delivers the members a config tree cannot carry', async () => {
    const serializers = { key: () => Buffer.from('k') }
    const onError = (): void => undefined

    const app = createApplication({}).extend(kafka('kafka', { clients: noopClients() }))
    app.config(c => c.source(env({ KAFKA__DEFAULT__BROKERS: 'from-env:9092' }), ConfigPriority.ENV))
    app.kafka(k => k.serializers(serializers).onError(onError))

    const built = app.build()
    await built.ready()

    const config = configOf(built.container, 'default')
    expect(config.brokers).toEqual(['from-env:9092'])
    expect(config.serializers.key).toBe(serializers.key)
    expect(config.onError).toBe(onError)

    await built.close()
  })

  // `deadLetter` is a boolean in config and an object in code; the object cannot travel, so code wins.
  it('prefers the code-set dead-letter options over the configured boolean', async () => {
    const topic = (): string => 'custom.DLT'

    const app = createApplication({}).extend(kafka('kafka', { clients: noopClients() }))
    app.config(c => c.source(new InlineConfigProvider({
      kafka: { default: { brokers: ['b:9092'], deadLetter: true } },
    })))
    app.kafka(k => k.deadLetter({ topic }))

    const built = app.build()
    await built.ready()

    expect(configOf(built.container, 'default').deadLetter).toEqual({ topic })

    await built.close()
  })

  it('honours a configured deadLetter: false when code set no object', async () => {
    const app = createApplication({}).extend(kafka('kafka', { clients: noopClients() }))
    app.config(c => c.source(new InlineConfigProvider({
      kafka: { default: { brokers: ['b:9092'], deadLetter: false } },
    })))
    app.kafka(k => k.brokers('b:9092'))

    const built = app.build()
    await built.ready()

    expect(configOf(built.container, 'default').deadLetter).toBe(false)

    await built.close()
  })

  // Activation is the builder call, never the tree.
  it('configures nothing for an instance the application never declared', async () => {
    const app = createApplication({}).extend(kafka('kafka', { clients: noopClients() }))
    app.config(c => c.source(new InlineConfigProvider({
      kafka: { ghost: { brokers: ['nobody:9092'] } },
    })))
    app.kafka(k => k.brokers('real:9092'))

    const built = app.build()
    await built.ready()

    expect(built.container.getOptional(runtimeKey('ghost'))).toBeUndefined()

    await built.close()
  })
})
