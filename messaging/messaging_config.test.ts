import { describe, expect, it } from 'vitest'
import type { Container } from '@caffeinejs/di'
import { $t, createApplication } from '@caffeinejs/std'
import { ConfigPriority, EnvConfigProvider, InlineConfigProvider } from '@caffeinejs/std/config'
import { inMemoryBinder } from './binder.testkit.js'
import type { MessagingRuntime } from './runtime.js'
import { messaging } from './plugin.js'
import { runtimeKey } from './symbols.js'

const env = (values: Record<string, string>) => new EnvConfigProvider({ env: values })

function runtimeOf(container: Container, instance = 'default'): MessagingRuntime {
  return container.get(runtimeKey(instance)) as MessagingRuntime
}

describe('messaging configuration', () => {
  // The regression the whole mechanism exists for: a destination is a topic name, and it differs per
  // environment exactly the way a broker list does.
  it('lets the environment override a builder-set destination', async () => {
    const app = createApplication({}).extend(messaging())
    app.config(c => c.source(
      env({ MESSAGING__DEFAULT__IN__ORDERS__DESTINATION: 'orders.v2' }),
      ConfigPriority.ENV,
    ))
    app.messaging(m => m
      .use('primary', inMemoryBinder())
      .in('orders', { destination: 'orders', via: 'primary' })
      .out('notify', { destination: 'notify', via: 'primary' }))

    const built = app.build()
    await built.ready()

    expect(runtimeOf(built.container).inbound.get('orders')?.destination).toBe('orders.v2')
    // Untouched by the environment, so the code values still stand.
    expect(runtimeOf(built.container).inbound.get('orders')?.via).toBe('primary')
    expect(runtimeOf(built.container).outbound.get('notify')?.destination).toBe('notify')

    await built.close()
  })

  it('reads a consumer group from the configuration tree', async () => {
    const app = createApplication({}).extend(messaging())
    app.config(c => c.source(new InlineConfigProvider({
      messaging: { default: { in: { orders: { group: 'from-config' } } } },
    })))
    app.messaging(m => m
      .use('primary', inMemoryBinder())
      .in('orders', { destination: 'orders', via: 'primary' }))

    const built = app.build()
    await built.ready()

    expect(runtimeOf(built.container).inbound.get('orders')?.group).toBe('from-config')

    await built.close()
  })

  it('keeps named instances apart, the unnamed one at messaging.default', async () => {
    const app = createApplication({}).extend(messaging())
    app.config(c => c.source(new InlineConfigProvider({
      messaging: { audit: { out: { log: { destination: 'audit.v2' } } } },
    })))
    app.messaging(m => m.use('primary', inMemoryBinder()).out('log', { destination: 'log', via: 'primary' }))
    app.messaging(m => m.named('audit').use('primary', inMemoryBinder()).out('log', { destination: 'log', via: 'primary' }))

    const built = app.build()
    await built.ready()

    expect(runtimeOf(built.container).outbound.get('log')?.destination).toBe('log')
    expect(runtimeOf(built.container, 'audit').outbound.get('log')?.destination).toBe('audit.v2')

    await built.close()
  })

  // The code-only members ride through untouched.
  it('keeps a code-only schema on a configured binding', async () => {
    const schema = $t.Object({ id: $t.Number() })

    const app = createApplication({}).extend(messaging())
    app.config(c => c.source(new InlineConfigProvider({
      messaging: { default: { in: { orders: { destination: 'orders.v2' } } } },
    })))
    app.messaging(m => m
      .use('primary', inMemoryBinder())
      .in('orders', { destination: 'orders', via: 'primary', schema }))

    const built = app.build()
    await built.ready()

    const binding = runtimeOf(built.container).inbound.get('orders')
    expect(binding?.destination).toBe('orders.v2')
    expect(binding?.schema).toBe(schema)

    await built.close()
  })

  it('re-points reads and code-set defaults together via .config()', async () => {
    const schema = $t.Object({
      app: $t.Object({
        events: $t.Object({
          in: $t.Optional($t.Record($t.String(), $t.Record($t.String(), $t.Unknown()))),
        }),
      }),
    })

    const app = createApplication({})
      .extend(messaging())
      .config(schema, c => c.source(new InlineConfigProvider({
        app: { events: { in: { orders: { destination: 'moved.orders' } } } },
      })))

    // No annotation on the selector: the config type is recovered from the builder.
    app.messaging(m => m
      .config(c => c.app.events)
      .use('primary', inMemoryBinder())
      .in('orders', { destination: 'orders', via: 'primary' }))

    const built = app.build()
    await built.ready()

    expect(runtimeOf(built.container).inbound.get('orders')?.destination).toBe('moved.orders')

    await built.close()
  })

  // Activation is the builder call, never the tree.
  it('creates no binding the application never declared', async () => {
    const app = createApplication({}).extend(messaging())
    app.config(c => c.source(new InlineConfigProvider({
      messaging: { default: { in: { ghost: { destination: 'ghost', via: 'primary' } } } },
    })))
    app.messaging(m => m
      .use('primary', inMemoryBinder())
      .in('orders', { destination: 'orders', via: 'primary' }))

    const built = app.build()
    await built.ready()

    expect(runtimeOf(built.container).inbound.has('ghost')).toBe(false)
    expect(runtimeOf(built.container).inbound.has('orders')).toBe(true)

    await built.close()
  })
})
