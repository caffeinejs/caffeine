import { token, type Container } from '@caffeinejs/di'
import { newConfiguration, createApplication } from '@caffeinejs/std'
import { EnvConfigSource, InlineConfigSource, type InferConfig } from '@caffeinejs/std/config'
import { $t } from '@caffeinejs/std/schema'
import { describe, expect, it } from 'vitest'

import { inMemoryBinder } from './binder.testkit.js'
import { messagingConfigSchema } from './config.js'
import { Consume } from './decorators/consume.js'
import { MessageHandler } from './decorators/message_handler.js'
import { messaging } from './plugin.js'
import type { MessagingRuntime } from './runtime.js'
import { runtimeKey } from './symbols.js'

// Every inbound binding needs a consumer: the engine now starts during `ready()` (via the `MessagingLifecycle`
// OnBootstrap hook), so a routeless inbound binding fails there rather than at `run()`.
@MessageHandler()
class OrdersConsumer {
  @Consume('orders')
  on() {}
}

void [OrdersConsumer]

// The application owns the schema: it declares one block per messaging instance — by importing the feature's
// own schema, given a default so a block a test never configures still materializes — and each `.extend`
// points its instance at the matching block.
const instanceSchema = $t.Object(messagingConfigSchema.properties, { default: {} })
const rootSchema = $t.Object({
  messaging: $t.Object({ default: instanceSchema, audit: instanceSchema }, { default: {} }),
})
const kRootConfig = token<InferConfig<typeof rootSchema>>(Symbol('app.config'))

const env = (values: Record<string, string>) => new EnvConfigSource({ env: values })

function runtimeOf(container: Container, instance = 'default'): MessagingRuntime {
  return container.get(runtimeKey(instance)) as MessagingRuntime
}

describe('messaging configuration', () => {
  // The regression the whole mechanism exists for: a destination is a topic name, and it differs per
  // environment exactly the way a broker list does. Named exception: messaging is config-wins once
  // `config(...)` is wired.
  it('lets the environment override a builder-set destination', async () => {
    const conf = newConfiguration(rootSchema, kRootConfig)
      .source(env({ MESSAGING__DEFAULT__IN__ORDERS__DESTINATION: 'orders.v2' }))
      .build()
    const app = createApplication({ config: conf }).with(
      messaging((m, { config }) =>
        m
          .config(config.messaging.default)
          .use('primary', inMemoryBinder())
          .in('orders', { destination: 'orders', via: 'primary' })
          .out('notify', { destination: 'notify', via: 'primary' }),
      ),
    )

    const built = app
    await built.ready()

    expect(runtimeOf(built.container).inbound.get('orders')?.destination).toBe('orders.v2')
    // Untouched by the environment, so the code values still stand.
    expect(runtimeOf(built.container).inbound.get('orders')?.via).toBe('primary')
    expect(runtimeOf(built.container).outbound.get('notify')?.destination).toBe('notify')

    await built.close()
  })

  it('reads a consumer group from the configuration tree', async () => {
    const conf = newConfiguration(rootSchema, kRootConfig)
      .source(new InlineConfigSource({ messaging: { default: { in: { orders: { group: 'from-config' } } } } }))
      .build()
    const app = createApplication({ config: conf }).with(
      messaging((m, { config }) =>
        m
          .config(config.messaging.default)
          .use('primary', inMemoryBinder())
          .in('orders', { destination: 'orders', via: 'primary' }),
      ),
    )

    const built = app
    await built.ready()

    expect(runtimeOf(built.container).inbound.get('orders')?.group).toBe('from-config')

    await built.close()
  })

  it('keeps named instances apart, the unnamed one at messaging.default', async () => {
    const conf = newConfiguration(rootSchema, kRootConfig)
      .source(new InlineConfigSource({ messaging: { audit: { out: { log: { destination: 'audit.v2' } } } } }))
      .build()
    const app = createApplication({ config: conf })
      .with(
        messaging((m, { config }) =>
          m
            .config(config.messaging.default)
            .use('primary', inMemoryBinder())
            .out('log', { destination: 'log', via: 'primary' }),
        ),
      )
      .with(
        messaging('audit', (m, { config }) =>
          m
            .config(config.messaging.audit)
            .use('primary', inMemoryBinder())
            .out('log', { destination: 'log', via: 'primary' }),
        ),
      )

    const built = app
    await built.ready()

    expect(runtimeOf(built.container).outbound.get('log')?.destination).toBe('log')
    expect(runtimeOf(built.container, 'audit').outbound.get('log')?.destination).toBe('audit.v2')

    await built.close()
  })

  // The code-only members ride through untouched.
  it('keeps a code-only schema on a configured binding', async () => {
    const schema = $t.Object({ id: $t.Number() })
    const kConfig = token<InferConfig<typeof schema>>(Symbol('app.config'))

    const conf = newConfiguration(rootSchema, kRootConfig)
      .source(new InlineConfigSource({ messaging: { default: { in: { orders: { destination: 'orders.v2' } } } } }))
      .build()
    const app = createApplication({ config: conf }).with(
      messaging((m, { config }) =>
        m
          .config(config.messaging.default)
          .use('primary', inMemoryBinder())
          .in('orders', { destination: 'orders', via: 'primary', schema }),
      ),
    )

    const built = app
    await built.ready()

    const binding = runtimeOf(built.container).inbound.get('orders')
    expect(binding?.destination).toBe('orders.v2')
    expect(binding?.schema).toBe(schema)

    await built.close()
  })

  it('re-points reads and code-set defaults together via the constructor-supplied config', async () => {
    const schema = $t.Object({
      app: $t.Object({
        events: $t.Object({
          in: $t.Optional($t.Record($t.String(), $t.Record($t.String(), $t.Unknown()))),
        }),
      }),
    })
    const kConfig = token<InferConfig<typeof schema>>(Symbol('app.config'))

    const conf = newConfiguration(schema, kConfig)
      .source(new InlineConfigSource({ app: { events: { in: { orders: { destination: 'moved.orders' } } } } }))
      .build()
    const app = createApplication({ config: conf })
      // No annotation on the selector: the config type is recovered from the builder.
      .with(
        messaging((m, { config }) =>
          m
            .config(config.app.events)
            .use('primary', inMemoryBinder())
            .in('orders', { destination: 'orders', via: 'primary' }),
        ),
      )

    const built = app
    await built.ready()

    expect(runtimeOf(built.container).inbound.get('orders')?.destination).toBe('moved.orders')

    await built.close()
  })

  // Activation is the builder call, never the tree.
  it('creates no binding the application never declared', async () => {
    const conf = newConfiguration(rootSchema, kRootConfig)
      .source(
        new InlineConfigSource({
          messaging: { default: { in: { ghost: { destination: 'ghost', via: 'primary' } } } },
        }),
      )
      .build()
    const app = createApplication({ config: conf }).with(
      messaging((m, { config }) =>
        m
          .config(config.messaging.default)
          .use('primary', inMemoryBinder())
          .in('orders', { destination: 'orders', via: 'primary' }),
      ),
    )

    const built = app
    await built.ready()

    expect(runtimeOf(built.container).inbound.has('ghost')).toBe(false)
    expect(runtimeOf(built.container).inbound.has('orders')).toBe(true)

    await built.close()
  })

  it('exports the config schema from the package barrel', async () => {
    const { messagingConfigSchema: fromBarrel } = await import('./index.js')
    expect(fromBarrel).toBeDefined()
  })
})
