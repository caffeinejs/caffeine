import { type Feature } from '@caffeinejs/std'

import { defaultKafkaClients } from './clients.js'
import type { KafkaClients } from './config.js'
import { KafkaBuilder } from './kafka_builder.js'
import { DEFAULT_INSTANCE } from './symbols.js'

/** Options for the {@link kafka} feature. `clients` is an internal seam for tests to inject a fake broker. */
export interface KafkaPluginOptions {
  clients?: KafkaClients
}

/** The builder callback that configures one kafka instance, over an application config type `C`. */
export type KafkaConfigure<C = unknown> = (k: KafkaBuilder<C>) => void

/**
 * The Kafka integration feature. `.extend(kafka(), k => …)` configures the default instance;
 * `.extend(kafka('orders'), k => …)` configures a named one. Each install binds that instance's
 * `KafkaTemplate` and `KafkaListenerContainer`; a single `KafkaLifecycle` bean (bound once) starts every
 * instance's engine during `container.init()` and stops it during `container.dispose()`.
 *
 * `options.clients` is a test seam for a fake broker; pass it once and reuse the partially applied feature.
 *
 * ```ts
 * const app = createApplication()
 *   .extend(kafka(), k => k.brokers('localhost:9092').groupId('svc'))
 *   .extend(kafka('orders'), k => k.brokers('localhost:9092').groupId('orders'))
 * await app.build().run()
 * ```
 */
export function kafka(instance: string = DEFAULT_INSTANCE, options: KafkaPluginOptions = {}): Feature<KafkaBuilder> {
  const clients = options.clients ?? defaultKafkaClients

  return {
    name: instance === DEFAULT_INSTANCE ? 'kafka' : `kafka:${instance}`,
    install(ctx, configure) {
      const builder = new KafkaBuilder(clients, instance)
      configure?.(builder)
      ctx.addFeature(builder)
    },
  }
}
