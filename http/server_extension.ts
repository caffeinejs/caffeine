import type { Extension, ExtensionIn } from '@caffeinejs/std'
import type { FastifyInstance } from 'fastify'

import type { RouteGroup } from './route.js'
import type { Services } from './service.js'

/** The resolved application, handed to an extension at start-up. */
export interface ServerExtensionContext extends ExtensionIn {
  /** The root server. Extensions run un-encapsulated, so a decoration here reaches every controller. */
  server: FastifyInstance
  services: Services
  /** Every route the application resolved, already built — read it, do not expect to add to it. */
  routeGroups: RouteGroup<any>[]
}

/**
 * How a package outside `http` wires the Fastify server at start-up: register routes, register a Fastify
 * plugin, add a content-type parser, read the resolved routing.
 *
 * A feature binds one under its own key and registers that key, both from its bootstrap hook — binding alone
 * registers nothing:
 *
 * ```ts
 * kit.container.bind(MyExtension, t => t.toValue(new MyExtension(options)))
 * kit.extensions.add(MyExtension)
 * ```
 *
 * The adapter registers each as a Fastify plugin, so it appears by name in `fastify.printPlugins()` and in
 * avvio's boot timings, and the metadata below is enforced by Fastify itself.
 *
 * **For per-request work, write a `Middleware` instead.** This runs once, at start-up, and never sees a
 * request.
 */
export abstract class ServerExtension implements Extension<ServerExtensionContext> {
  /** Identifies the extension to Fastify: shown in `printPlugins()` and named in dependency failures. */
  abstract readonly name: string

  /**
   * Plugin names that must already be registered when this one is.
   *
   * Asserted, never reordered — extensions run in the order their features were installed, which is the order
   * the application's `.extend()` calls were written, whatever a feature awaits before registering. A missing
   * dependency is a start-up error naming both sides, which is what tells the user to reorder those calls; it
   * is not a request for the framework to sort them.
   */
  readonly dependencies?: readonly string[]

  /** Decorators this extension needs in place. A missing one fails start-up naming the decorator. */
  readonly decorators?: { fastify?: string[]; request?: string[]; reply?: string[] }

  /** Accepted Fastify version range, e.g. `'5.x'`. */
  readonly fastify?: string

  abstract configure(ctx: ServerExtensionContext): void | Promise<void>
}
