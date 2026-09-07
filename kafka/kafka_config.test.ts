import { token, type Container } from '@caffeinejs/di'
import { $t, type InferSchema, createApplication } from '@caffeinejs/std'
import { ConfigPriority, EnvConfigProvider, InlineConfigProvider, type ConfigHandle } from '@caffeinejs/std/config'
import { describe, expect, it } from 'vitest'

import {
  kafkaConfigSchema,
  type ConsumerClient,
  type KafkaClients,
  type ProducerClient,
  type ResolvedKafkaConfig,
} from './config.js'
import { kafka } from './plugin.js'
import type { KafkaRuntime } from './runtime.js'
import { runtimeKey } from './symbols.js'

// The application owns the schema: it declares one block per kafka instance — by importing the feature's own
// schema rather than restating it — and each `.extend` points its instance at the matching block.
// The feature's own schema, given a default so a block a test never configures still materializes.
const instanceSchema = $t.Object(kafkaConfigSchema.properties, { default: {} })
const rootSchema = $t.Object({
  kafka: $t.Object({ default: instanceSchema, orders: instanceSchema }, { default: {} }),
})
const kRootConfig = token<ConfigHandle<InferSchema<typeof rootSchema>>>(Symbol('app.config'))

function noopClients(): KafkaClients {
  const producer: ProducerClient = { send: () => Promise.resolve(), close: () => Promise.resolve() }
  const consumer: ConsumerClient = {
    consume: () =>
      Promise.resolve(Object.assign({ async *[Symbol.asyncIterator]() {} }, { close: () => Promise.resolve() })),
    close: () => Promise.resolve(),
  }
  return { createProducer: () => producer, createConsumer: () => consumer }
}

function configOf(container: Container, instance: string): ResolvedKafkaConfig {
  return (container.get(runtimeKey(instance)) as KafkaRuntime).config
}

const env = (values: Record<string, string>) => new EnvConfigProvider({ env: values })

describe('kafka configuration', () => {
  it('reads brokers from the configuration tree with no builder call at all', async () => {
    const kfk = kafka.with({ clients: noopClients() })
    const app = createApplication({})
      .config(rootSchema, kRootConfig, c =>
        c.source(
          new InlineConfigProvider({
            kafka: { default: { brokers: ['from-config:9092'], groupId: 'from-config' } },
          }),
        ),
      )
      .extend(kfk, k => k.config(c => c.kafka.default))

    const built = app.build()
    await built.ready()

    expect(configOf(built.container, 'default').brokers).toEqual(['from-config:9092'])
    expect(configOf(built.container, 'default').groupId).toBe('from-config')

    await built.close()
  })

  // The regression the whole mechanism exists for: a builder method is a default, not a setting.
  it('lets the environment override a builder-set broker list', async () => {
    const kfk = kafka.with({ clients: noopClients() })
    const app = createApplication({})
      .config(rootSchema, kRootConfig, c =>
        c.source(env({ KAFKA__DEFAULT__BROKERS: 'prod-1:9092,prod-2:9092' }), ConfigPriority.ENV),
      )
      .extend(kfk, k =>
        k
          .config(c => c.kafka.default)
          .brokers('localhost:9092')
          .groupId('svc'),
      )

    const built = app.build()
    await built.ready()

    expect(configOf(built.container, 'default').brokers).toEqual(['prod-1:9092', 'prod-2:9092'])
    // Untouched by the environment, so the code value still stands.
    expect(configOf(built.container, 'default').groupId).toBe('svc')

    await built.close()
  })

  it('keeps named instances apart, the unnamed one at kafka.default', async () => {
    const kfk = kafka.with({ clients: noopClients() })
    // `GROUP_ID`, not `GROUPID`: the env provider folds underscores *within* a segment into camelCase, so an
    // all-uppercase run has no word boundary to find and `GROUPID` would resolve to `groupid`.
    const app = createApplication({})
      .config(rootSchema, kRootConfig, c =>
        c.source(env({ KAFKA__ORDERS__GROUP_ID: 'orders-canary' }), ConfigPriority.ENV),
      )
      .extend(kfk, k =>
        k
          .config(c => c.kafka.default)
          .brokers('b1:9092')
          .groupId('svc'),
      )
      .extend(kfk('orders'), k =>
        k
          .config(c => c.kafka.orders)
          .brokers('b2:9092')
          .groupId('orders'),
      )

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
    const kConfig = token<ConfigHandle<InferSchema<typeof schema>>>(Symbol('app.config'))

    const kfk = kafka.with({ clients: noopClients() })
    const app = createApplication({})
      .config(schema, kConfig, c =>
        c.source(
          new InlineConfigProvider({
            app: { events: { groupId: 'from-moved-path' } },
          }),
        ),
      )
      // No annotation on the selector: the config type is recovered from the builder.
      .extend(kfk, k => k.brokers('moved:9092').config(c => c.app.events))

    const built = app.build()
    await built.ready()

    expect(configOf(built.container, 'default').brokers).toEqual(['moved:9092'])
    expect(configOf(built.container, 'default').groupId).toBe('from-moved-path')
    // Nothing was written at the default namespace — `kafka` is not a key of the tree the application declared.
    expect(Object.keys(built.container.get(kConfig))).not.toContain('kafka')

    await built.close()
  })

  it('still delivers the members a config tree cannot carry', async () => {
    const serializers = { key: () => Buffer.from('k') }
    const onError = (): void => undefined

    const kfk = kafka.with({ clients: noopClients() })
    const app = createApplication({})
      .config(rootSchema, kRootConfig, c =>
        c.source(env({ KAFKA__DEFAULT__BROKERS: 'from-env:9092' }), ConfigPriority.ENV),
      )
      .extend(kfk, k =>
        k
          .config(c => c.kafka.default)
          .serializers(serializers)
          .onError(onError),
      )

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

    const kfk = kafka.with({ clients: noopClients() })
    const app = createApplication({})
      .config(rootSchema, kRootConfig, c =>
        c.source(
          new InlineConfigProvider({
            kafka: { default: { brokers: ['b:9092'], deadLetter: true } },
          }),
        ),
      )
      .extend(kfk, k => k.config(c => c.kafka.default).deadLetter({ topic }))

    const built = app.build()
    await built.ready()

    expect(configOf(built.container, 'default').deadLetter).toEqual({ topic })

    await built.close()
  })

  it('honours a configured deadLetter: false when code set no object', async () => {
    const kfk = kafka.with({ clients: noopClients() })
    const app = createApplication({})
      .config(rootSchema, kRootConfig, c =>
        c.source(
          new InlineConfigProvider({
            kafka: { default: { brokers: ['b:9092'], deadLetter: false } },
          }),
        ),
      )
      .extend(kfk, k => k.config(c => c.kafka.default).brokers('b:9092'))

    const built = app.build()
    await built.ready()

    expect(configOf(built.container, 'default').deadLetter).toBe(false)

    await built.close()
  })

  // Activation is the builder call, never the tree.
  it('configures nothing for an instance the application never declared', async () => {
    const kfk = kafka.with({ clients: noopClients() })
    const app = createApplication({})
      .config(rootSchema, kRootConfig, c =>
        c.source(
          new InlineConfigProvider({
            kafka: { ghost: { brokers: ['nobody:9092'] } },
          }),
        ),
      )
      .extend(kfk, k => k.config(c => c.kafka.default).brokers('real:9092'))

    const built = app.build()
    await built.ready()

    expect(built.container.getOptional(runtimeKey('ghost'))).toBeUndefined()

    await built.close()
  })
})
