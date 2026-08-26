import type { Container } from '@caffeinejs/di'
import type { Plugin, Service } from '@caffeinejs/std'
import { MessagingBuilder } from './builder.js'
import type { MessagingContainer } from './engine.js'
import { DEFAULT_BINDER, Keys } from './symbols.js'

/** The builder callback that configures one messaging integration. */
export type MessagingConfigure = (m: MessagingBuilder) => void

/**
 * The `messaging` builder method contributed by the plugin. Pass a builder callback, optionally preceded by an
 * integration name, and get the builder back for chaining.
 */
export interface MessagingMethod {
  <Self>(this: Self, configure: MessagingConfigure): Self
  <Self>(this: Self, name: string, configure: MessagingConfigure): Self
}

// What the method needs from the builder it is invoked on (`this`). `.bind()` in a Service does not emit the
// hook events, so the engine is started/stopped through programmatic lifecycle listeners registered here.
interface MessagingBuilderHost {
  addService(service: Service): unknown
  on(
    event: 'application:run' | 'application:pre-shutdown',
    listener: (app: { readonly container: Container }) => void | Promise<void>,
  ): unknown
}

/**
 * The portable messaging plugin. Adds a `messaging(...)` method to the application builder that registers binder
 * instances and declares bindings; the engine starts on `application:run` and stops on
 * `application:pre-shutdown`. Additive — a single-binder app that only uses a binder package's own sugar (e.g.
 * `app.kafka(...)`) does not need this plugin.
 *
 * ```ts
 * const app = createApplication().extend(messaging())
 * app.messaging(m => m
 *   .use('primary', inMemoryBinder())
 *   .in('orders', { destination: 'orders', via: 'primary' })
 *   .out('notify', { destination: 'notify', via: 'primary' }))
 * await app.build().run()
 * ```
 *
 * @param name - The builder method name (default `messaging`); rename to install the plugin more than once.
 */
export function messaging<const Name extends string = 'messaging'>(
  name: Name = 'messaging' as Name,
): Plugin<Record<Name, MessagingMethod>> {
  let lifecycleRegistered = false

  function registerLifecycle(host: MessagingBuilderHost): void {
    if (lifecycleRegistered) {
      return
    }
    lifecycleRegistered = true

    host.on('application:run', async app => {
      for (const { binding } of app.container.getBindingsByLabel(Keys.MESSAGING_CONTAINER)) {
        await app.container.wrapBinding<MessagingContainer>(binding).get().start()
      }
    })
    host.on('application:pre-shutdown', async app => {
      for (const { binding } of app.container.getBindingsByLabel(Keys.MESSAGING_CONTAINER)) {
        await app.container.wrapBinding<MessagingContainer>(binding).get().stop()
      }
    })
  }

  // A regular function so `this` binds to the builder at the `app.messaging(...)` call site.
  function messagingMethod(
    this: MessagingBuilderHost,
    nameOrConfigure: string | MessagingConfigure,
    maybeConfigure?: MessagingConfigure,
  ): unknown {
    const instance = typeof nameOrConfigure === 'string' ? nameOrConfigure : DEFAULT_BINDER
    const configure = typeof nameOrConfigure === 'string' ? maybeConfigure : nameOrConfigure
    if (configure === undefined) {
      throw new TypeError('messaging(): a configure callback is required')
    }

    const builder = new MessagingBuilder(instance)
    configure(builder)
    this.addService(builder)
    registerLifecycle(this)

    return this
  }

  return {
    name,
    install() {
      return { [name]: messagingMethod } as Record<Name, MessagingMethod>
    },
  }
}
