import { FeatureBuilder, type Feature } from '@caffeinejs/std'
import type { FastifyInstance } from 'fastify'

import type { HTTPSetupContext } from './setup_context.js'

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
 * at `.with(...)`. The hook is handed the same {@link HTTPSetupContext} a plugin factory gets, so `kit.container`
 * resolves; a subclass of {@link HTTPFeatureBuilder} reads it typed by `C`, as `configure` is.
 */
export interface HTTPFeature<C = unknown, I = FastifyInstance> extends Feature<C> {
  // A property rather than a method: a method's parameter is compared bivariantly, which would let a feature
  // written for one server install on an application running another. `I` is therefore checked strictly, and the
  // kit deliberately is not typed by `C` here: it would make `C` invariant too, and an application held without
  // its configuration type — `function portOf(app: WebApplication)` — could no longer take a configured one.
  readonly [kFeatureServer]: (instance: I, kit: HTTPSetupContext) => void | Promise<void>
}

/**
 * A {@link FeatureBuilder} that also wires the server: a subclass overrides {@link server} as well as, or instead
 * of, `configure` and `bootstrap`.
 */
export abstract class HTTPFeatureBuilder<C = unknown, I = FastifyInstance>
  extends FeatureBuilder<C>
  implements HTTPFeature<C, I>
{
  // The kit the application hands over is typed by its own configuration; the interface erases that to keep `C`
  // out of the variance check, so it is restored here. This is the same trade `configure` already makes, whose
  // hook is a bivariant method while `FeatureBuilder.configure` is handed `FeatureConfigureKit<C>`.
  readonly [kFeatureServer] = (instance: I, kit: HTTPSetupContext): void | Promise<void> =>
    this.server(instance, kit as HTTPSetupContext<C>)

  /** Wires the server. Runs at the feature's install position, after the container has initialized. */
  protected server(_instance: I, _kit: HTTPSetupContext<C>): void | Promise<void> {
    // Nothing to wire.
  }
}
