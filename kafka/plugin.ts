import type { Feature, FeatureConfigurer } from '@caffeinejs/std'

import { defaultKafkaClients } from './clients.js'
import type { KafkaClients } from './config.js'
import { KafkaBuilder } from './kafka_builder.js'
import { DEFAULT_INSTANCE } from './symbols.js'

/** Options for the {@link kafka} feature. `clients` is an internal seam for tests to inject a fake broker. */
export interface KafkaPluginOptions {
  clients?: KafkaClients
}

/** The builder callback that configures one kafka instance, over an application config type `C`. */
export type KafkaConfigurer<C = unknown> = FeatureConfigurer<KafkaBuilder<C>, C>

/**
 * The Kafka integration feature. `.install(Kafka(k => …))` configures the default instance;
 * `.install(Kafka('orders', k => …))` configures a named one. Each install binds that instance's
 * `KafkaTemplate` and `KafkaListenerContainer`; a single `KafkaLifecycle` bean (bound once) starts every
 * instance's engine during `container.init()` and stops it during `container.dispose()`.
 *
 * `options.clients` is a test seam for a fake broker.
 *
 * ```ts
 * const app = createApplication()
 *   .install(Kafka(k => k.brokers('localhost:9092').groupId('svc')))
 *   .install(Kafka('orders', k => k.brokers('localhost:9092').groupId('orders')))
 * await app.run()
 * ```
 */
export function Kafka<C = unknown>(configure?: KafkaConfigurer<C>, options?: KafkaPluginOptions): Feature<C>
export function Kafka<C = unknown>(
  instance: string,
  configure?: KafkaConfigurer<C>,
  options?: KafkaPluginOptions,
): Feature<C>
export function Kafka<C = unknown>(
  instanceOrConfigure?: string | KafkaConfigurer<C>,
  configureOrOptions?: KafkaConfigurer<C> | KafkaPluginOptions,
  maybeOptions?: KafkaPluginOptions,
): Feature<C> {
  const named = typeof instanceOrConfigure === 'string'
  const instance = named ? instanceOrConfigure : DEFAULT_INSTANCE
  const configure = (named ? configureOrOptions : instanceOrConfigure) as KafkaConfigurer<C> | undefined
  const options = (named ? maybeOptions : (configureOrOptions as KafkaPluginOptions | undefined)) ?? {}

  return new KafkaBuilder<C>(options.clients ?? defaultKafkaClients, instance, configure)
}
