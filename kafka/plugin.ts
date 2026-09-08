import {
  defineKeyedFeature,
  kFeatureSetup,
  type KeyedFeature,
  type PluginContext,
  type TypeLambda,
} from '@caffeinejs/std'

import { defaultKafkaClients } from './clients.js'
import type { KafkaClients } from './config.js'
import { ErrKafkaUnknownInstance } from './errors.js'
import { KafkaBuilder } from './kafka_builder.js'
import type { KafkaListenerContainer } from './listener_container.js'
import { DEFAULT_INSTANCE, Keys } from './symbols.js'

/** Options for the {@link kafka} feature. `clients` is an internal seam for tests to inject a fake broker. */
export interface KafkaPluginOptions {
  clients?: KafkaClients
}

/** The builder callback that configures one kafka instance, over an application config type `C`. */
export type KafkaConfigure<C = unknown> = (k: KafkaBuilder<C>) => void

interface KafkaBuilderF extends TypeLambda {
  readonly Out: KafkaBuilder<this['In']>
}

export interface KafkaFeature extends KeyedFeature<KafkaBuilder, KafkaBuilderF> {
  with(options: KafkaPluginOptions): KafkaFeature
  readonly _F: KafkaBuilderF
}

const LIFECYCLE = 'kafka:lifecycle'

function registerLifecycle(ctx: PluginContext): void {
  if (ctx.state.has(LIFECYCLE)) {
    return
  }
  ctx.state.set(LIFECYCLE, true)

  ctx.on('application:run', async app => {
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
  ctx.on('application:pre-shutdown', async app => {
    for (const { binding } of app.container.getBindingsByLabel(Keys.KAFKA_CONTAINER)) {
      await app.container.wrapBinding<KafkaListenerContainer>(binding).get().stop()
    }
  })
}

function createKafka(options: KafkaPluginOptions = {}): KafkaFeature {
  const clients = options.clients ?? defaultKafkaClients
  const feature = defineKeyedFeature<KafkaBuilder>({
    name: 'kafka',
    defaultInstance: DEFAULT_INSTANCE,
    install(ctx, instance, configure) {
      const builder = new KafkaBuilder(clients, instance)
      configure?.(builder)
      ctx.addFeature(builder[kFeatureSetup]())
      registerLifecycle(ctx)
    },
  })

  return Object.assign(feature, {
    with(opts: KafkaPluginOptions): KafkaFeature {
      return createKafka(opts)
    },
  }) as KafkaFeature
}

/**
 * The Kafka integration feature. `.extend(kafka, k => …)` configures the default instance;
 * `.extend(kafka('orders'), k => …)` configures a named one. Each install binds that instance's
 * `KafkaTemplate` and `KafkaListenerContainer`; the feature starts every instance's engine on
 * `application:run` and stops it on `application:pre-shutdown`.
 *
 * ```ts
 * const app = createApplication()
 *   .extend(kafka, k => k.brokers('localhost:9092').groupId('svc'))
 *   .extend(kafka('orders'), k => k.brokers('localhost:9092').groupId('orders'))
 * await app.build().run()
 * ```
 */
export const kafka: KafkaFeature = createKafka()
