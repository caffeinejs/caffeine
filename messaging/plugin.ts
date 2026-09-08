import { defineKeyedFeature, type KeyedFeature, type PluginContext, type TypeLambda } from '@caffeinejs/std'

import { MessagingBuilder } from './builder.js'
import type { MessagingContainer } from './engine.js'
import { DEFAULT_BINDER, Keys } from './symbols.js'

/** The builder callback that configures one messaging integration, over an application config type `C`. */
export type MessagingConfigure<C = unknown> = (m: MessagingBuilder<C>) => void

interface MessagingBuilderF extends TypeLambda {
  readonly Out: MessagingBuilder<this['In']>
}

export interface MessagingFeature extends KeyedFeature<MessagingBuilder, MessagingBuilderF> {
  readonly _F: MessagingBuilderF
}

const LIFECYCLE = 'messaging:lifecycle'

function registerLifecycle(ctx: PluginContext): void {
  if (ctx.state.has(LIFECYCLE)) {
    return
  }
  ctx.state.set(LIFECYCLE, true)

  ctx.on('application:run', async app => {
    for (const { binding } of app.container.getBindingsByLabel(Keys.MESSAGING_CONTAINER)) {
      await app.container.wrapBinding<MessagingContainer>(binding).get().start()
    }
  })
  ctx.on('application:pre-shutdown', async app => {
    for (const { binding } of app.container.getBindingsByLabel(Keys.MESSAGING_CONTAINER)) {
      await app.container.wrapBinding<MessagingContainer>(binding).get().stop()
    }
  })
}

/**
 * The portable messaging feature. `.extend(messaging, m => …)` registers binder instances and bindings;
 * the engine starts on `application:run` and stops on `application:pre-shutdown`. Additive — a
 * single-binder app that only uses a binder package's own sugar (e.g. `.extend(kafka, …)`) does not need
 * this feature.
 *
 * ```ts
 * const app = createApplication()
 *   .extend(messaging, m => m
 *     .use('primary', inMemoryBinder())
 *     .in('orders', { destination: 'orders', via: 'primary' })
 *     .out('notify', { destination: 'notify', via: 'primary' }))
 * await app.build().run()
 * ```
 */
export const messaging: MessagingFeature = defineKeyedFeature({
  name: 'messaging',
  defaultInstance: DEFAULT_BINDER,
  install(ctx, instance, configure) {
    const builder = new MessagingBuilder(instance)
    configure?.(builder)
    ctx.addFeature(builder)
    registerLifecycle(ctx)
  },
}) as MessagingFeature
