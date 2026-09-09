import { type Feature } from '@caffeinejs/std'

import { MessagingBuilder } from './builder.js'
import { DEFAULT_BINDER } from './symbols.js'

/** The builder callback that configures one messaging integration, over an application config type `C`. */
export type MessagingConfigure<C = unknown> = (m: MessagingBuilder<C>) => void

/**
 * The portable messaging feature. `.extend(messaging(), m => …)` registers binder instances and bindings; a
 * single `MessagingLifecycle` bean (bound once) starts every engine during `container.init()` and stops it
 * during `container.dispose()`. `.extend(messaging('audit'), m => …)` configures a named binder set. Additive
 * — a single-binder app that only uses a binder package's own sugar (e.g. `.extend(kafka(), …)`) does not
 * need this feature.
 *
 * ```ts
 * const app = createApplication()
 *   .extend(messaging(), m => m
 *     .use('primary', inMemoryBinder())
 *     .in('orders', { destination: 'orders', via: 'primary' })
 *     .out('notify', { destination: 'notify', via: 'primary' }))
 * await app.build().run()
 * ```
 */
export function messaging(instance: string = DEFAULT_BINDER): Feature<MessagingBuilder> {
  return {
    name: instance === DEFAULT_BINDER ? 'messaging' : `messaging:${instance}`,
    install(ctx, configure) {
      const builder = new MessagingBuilder(instance)
      configure?.(builder)
      ctx.addFeature(builder)
    },
  }
}
