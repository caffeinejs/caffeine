import type { Container } from '@caffeinejs/di'
import type { Plugin, Service } from '@caffeinejs/std'
import { defaultKafkaClients } from './clients.js'
import type { KafkaClients } from './config.js'
import { ErrKafkaUnknownInstance } from './errors.js'
import { KafkaBuilder } from './kafka_builder.js'
import type { KafkaListenerContainer } from './listener_container.js'
import { DEFAULT_INSTANCE, Keys } from './symbols.js'

/** Options for the {@link kafka} plugin. `clients` is an internal seam for tests to inject a fake broker. */
export interface KafkaPluginOptions {
  clients?: KafkaClients
}

/** The builder callback that configures one kafka instance. */
export type KafkaConfigure = (k: KafkaBuilder) => void

/**
 * The `kafka` builder method contributed by the plugin. Follows the feature-builder convention: pass a builder
 * callback, optionally preceded by an instance name, and get the builder back for chaining.
 */
export interface KafkaMethod {
  <Self>(this: Self, configure: KafkaConfigure): Self
  <Self>(this: Self, name: string, configure: KafkaConfigure): Self
}

// What the method needs from the builder it is invoked on (`this`). `.bind()` in a Service does not emit the
// hook events, so the engines are started/stopped through programmatic lifecycle listeners registered here.
interface KafkaBuilderHost {
  addService(service: Service): unknown
  on(
    event: 'application:run' | 'application:pre-shutdown',
    listener: (app: { readonly container: Container }) => void | Promise<void>,
  ): unknown
}

/**
 * The Kafka integration plugin. Adds a `kafka(...)` method to the application builder that configures one
 * (optionally named) integration per call. Each call binds that instance's `KafkaTemplate` and
 * `KafkaListenerContainer`; the plugin starts every instance's engine on `application:run` and stops it on
 * `application:pre-shutdown`. Works with both the headless `createApplication` and the HTTP
 * `createWebApplication`.
 *
 * ```ts
 * const app = createApplication().extend(kafka())
 * app.kafka(k => k.brokers('localhost:9092').groupId('svc'))          // default instance
 * app.kafka('orders', k => k.brokers('localhost:9092').groupId('orders'))  // named instance
 * await app.build().run()
 * ```
 *
 * @param name - The builder method name (default `kafka`); rename to install the plugin more than once.
 * @param options - Advanced options; `clients` overrides the platformatic client factory (tests).
 */
export function kafka<const Name extends string = 'kafka'>(
  name: Name = 'kafka' as Name,
  options: KafkaPluginOptions = {},
): Plugin<Record<Name, KafkaMethod>> {
  const clients = options.clients ?? defaultKafkaClients
  let lifecycleRegistered = false

  function registerLifecycle(host: KafkaBuilderHost): void {
    if (lifecycleRegistered) {
      return
    }
    lifecycleRegistered = true

    host.on('application:run', async app => {
      const engines = app.container
        .getBindingsByLabel(Keys.KAFKA_CONTAINER)
        .map(({ binding }) => app.container.wrapBinding<KafkaListenerContainer>(binding).get())
      const configured = new Set(engines.map(engine => engine.name))

      // Fail fast: a handler tagged for an instance that was never configured would otherwise never run.
      for (const { key, binding } of app.container.getBindingsByLabel(Keys.KAFKA_HANDLER)) {
        const instance = (binding.tags.get(Keys.KAFKA_INSTANCE) as string | undefined) ?? DEFAULT_INSTANCE
        if (!configured.has(instance)) {
          const handler = (binding.type as { name?: string } | undefined)?.name ?? String(key)
          throw new ErrKafkaUnknownInstance(handler, instance, [...configured])
        }
      }

      for (const engine of engines) {
        await engine.start()
      }
    })
    host.on('application:pre-shutdown', async app => {
      for (const { binding } of app.container.getBindingsByLabel(Keys.KAFKA_CONTAINER)) {
        await app.container.wrapBinding<KafkaListenerContainer>(binding).get().stop()
      }
    })
  }

  // A regular function so `this` binds to the builder at the `app.kafka(...)` call site.
  function kafkaMethod(
    this: KafkaBuilderHost,
    nameOrConfigure: string | KafkaConfigure,
    maybeConfigure?: KafkaConfigure,
  ): unknown {
    const instance = typeof nameOrConfigure === 'string' ? nameOrConfigure : DEFAULT_INSTANCE
    const configure = typeof nameOrConfigure === 'string' ? maybeConfigure : nameOrConfigure
    if (configure === undefined) {
      throw new TypeError('kafka(): a configure callback is required')
    }

    const builder = new KafkaBuilder(instance, clients)
    configure(builder)
    this.addService(builder)
    registerLifecycle(this)

    return this
  }

  return {
    name,
    install() {
      return { [name]: kafkaMethod } as Record<Name, KafkaMethod>
    },
  }
}
