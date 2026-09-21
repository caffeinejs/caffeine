import type { Feature, FeatureConfigurer } from '@caffeinejs/std'

import { MessagingBuilder } from './builder.js'
import { DEFAULT_BINDER } from './symbols.js'

/** The builder callback that configures one messaging integration, over an application config type `C`. */
export type MessagingConfigurer<C = unknown> = FeatureConfigurer<MessagingBuilder<C>, C>

/**
 * The portable messaging feature. `.with(messaging(m => …))` registers binder instances and bindings; a
 * single `MessagingLifecycle` bean (bound once) starts every engine during `container.init()` and stops it
 * during `container.dispose()`. `.with(messaging('audit', m => …))` configures a named binder set. Additive
 * — a single-binder app that only uses a binder package's own sugar (e.g. `.with(kafka())`) does not need
 * this feature.
 *
 * ```ts
 * const app = createApplication()
 *   .with(messaging(m => m
 *     .use('primary', inMemoryBinder())
 *     .in('orders', { destination: 'orders', via: 'primary' })
 *     .out('notify', { destination: 'notify', via: 'primary' })))
 * await app.run()
 * ```
 */
export function messaging<C = unknown>(configure?: MessagingConfigurer<C>): Feature<C>
export function messaging<C = unknown>(instance: string, configure?: MessagingConfigurer<C>): Feature<C>
export function messaging<C = unknown>(
  instanceOrConfigure?: string | MessagingConfigurer<C>,
  maybeConfigure?: MessagingConfigurer<C>,
): Feature<C> {
  const instance = typeof instanceOrConfigure === 'string' ? instanceOrConfigure : DEFAULT_BINDER
  const configure = typeof instanceOrConfigure === 'string' ? maybeConfigure : instanceOrConfigure

  return new MessagingBuilder<C>(instance, configure)
}
