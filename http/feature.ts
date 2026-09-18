import { FeatureBuilder, type BootstrapKit, type Feature } from '@caffeinejs/std'
import type { FastifyInstance } from 'fastify'

/** The key an {@link HTTPFeature}'s server hook hangs off, kept off the builder's fluent surface. */
export const kFeatureServer = Symbol('caffeine.http.feature.server')

/**
 * A feature that also wires the server: registers plugins, adds hooks, decorates.
 *
 * The hook runs once during start-up, after the container has initialized, at the position the feature was
 * installed: everything written before it in the `.with(...)` chain is installed first, and nothing written after
 * it starts until the hook, and whatever it registered, has finished. Under the Fastify adapter the hook body is a
 * `fastify-plugin` plugin body, so `instance` is the root server and what it registers covers every route.
 *
 * `I` is the server the feature is written against. An application whose adapter drives another server refuses it
 * at `.with(...)`. `kit.config` is untyped here, as in `bootstrap`: the typed path is the configure callback.
 */
export interface HTTPFeature<C = unknown, I = FastifyInstance> extends Feature<C> {
  // A property rather than a method: a method's parameter is compared bivariantly, which would let a feature
  // written for one server install on an application running another. The kit is not typed by `C` for the same
  // reason in reverse: a strict `C` there would stop an application typed by its configuration from widening to
  // one typed by none.
  readonly [kFeatureServer]: (instance: I, kit: BootstrapKit) => void | Promise<void>
}

/**
 * A {@link FeatureBuilder} that also wires the server: a subclass overrides {@link server} as well as, or instead
 * of, `configure` and `bootstrap`.
 */
export abstract class HTTPFeatureBuilder<C = unknown, I = FastifyInstance>
  extends FeatureBuilder<C>
  implements HTTPFeature<C, I>
{
  readonly [kFeatureServer] = (instance: I, kit: BootstrapKit): void | Promise<void> => this.server(instance, kit)

  /** Wires the server. Runs at the feature's install position, after the container has initialized. */
  protected server(_instance: I, _kit: BootstrapKit): void | Promise<void> {
    // Nothing to wire.
  }
}
