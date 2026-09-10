import { kExtensionStage, type Extension, type ExtensionIn, type ExtensionStage } from '@caffeinejs/std'
import type { FastifyInstance } from 'fastify'

import type { RouteGroup } from './route.js'
import type { AdapterRouteOptions } from './route_hooks.js'

/** Handed to a {@link RouteContributor} once, before the adapter registers any route. */
export interface RouteContributorContext extends ExtensionIn {
  /** The root instance. Un-encapsulated, so a decoration here reaches every route group. */
  server: FastifyInstance
  /** Every route group the application resolved, already compiled. Read it; do not expect to add to it. */
  routeGroups: RouteGroup<any>[]
}

/**
 * Per-route start-up wiring a feature outside `http` contributes and the adapter runs while it registers
 * routes. This is how `@caffeinejs/caching` attaches its Fastify hooks to the routes that asked for them
 * without the adapter knowing the feature exists.
 *
 * Register one from a feature bootstrap: `kit.extensions.register(MyContributor, new MyContributor())`. The
 * adapter resolves every registered contributor with `extensions.of(RouteContributor)` — in
 * {@link ExtensionStage} order, then feature-install order, the same ordering a `ServerExtension` gets.
 *
 * `configure` runs once, before the route loop, and is where container-bound dependencies are resolved and
 * the server is decorated. `onRoute` runs once per route. For per-request work an application author writes,
 * use `app.use()`; for server-wide start-up wiring, use `ServerExtension`.
 */
export abstract class RouteContributor implements Extension<RouteContributorContext> {
  /** Identifies the contributor in start-up diagnostics. */
  abstract readonly name: string

  readonly [kExtensionStage]?: ExtensionStage

  /** Runs once, before the route loop. Resolve container-bound dependencies and decorate the server here. */
  abstract configure(ctx: RouteContributorContext): void | Promise<void>

  /**
   * Runs once per route, with the mutable Fastify route options. `routeDef.config` is already populated from
   * what the route declared, so a contributor keys off it and calls `addRouteHook` only on the routes it
   * applies to — a route it does not touch keeps its hook slots undefined.
   */
  abstract onRoute(routeDef: AdapterRouteOptions): void
}
