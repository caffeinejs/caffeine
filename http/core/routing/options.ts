import { errMessage } from '@caffeinejs/std/err'

import { configureRoute, configureRouteGroup } from '../../decorators/registrar/registrar.js'
import type { HTTPSetupContext } from '../../plugin.js'
import { ErrConfiguration } from '../error/common.js'
import { asError, isThenable } from '../lifecycle/lifecycle.js'
import { mergeInto, mergeValue, ownKeys } from './_merge.js'

/**
 * What a route carries for the plugins that serve it: read with `ctx.options`, or `route.options` in an `onRoute` hook.
 *
 * Empty here. A plugin that takes per-route settings augments it with its own field, so a route that sets it is
 * checked and a reader gets the real type:
 *
 * ```ts
 * import '@caffeinejs/http'
 *
 * declare module '@caffeinejs/http' {
 *   interface RouteOptions {
 *     audit?: { level: 'full' | 'none' }
 *   }
 * }
 * ```
 *
 * The import keeps the file a module, so the block adds to the package's types instead of replacing them.
 *
 * Set with `.routeOptions(...)` on a route or a router, and `@RouteOptions(...)` on a controller or a method. Within
 * one of those levels, settings merge key by key: plain objects member by member, arrays joined, Maps merged by key and
 * Sets united, anything else replaced. A more specific level's key replaces a less specific one's whole value, except a
 * Map, which merges by key: a route's constraint keeps its router's version.
 */
export interface RouteOptions {
  /** Never set: keeps a route's options checked even where no plugin has declared a field. */
  readonly [kRouteOptions]?: never
}

declare const kRouteOptions: unique symbol

/**
 * Writes one level's route options from what the application resolved at start-up.
 *
 * It runs while routes compile: once per route for a route's, and once per router or controller for theirs, each time
 * the router is mounted. It sees and writes its own level's object only, and a more specific level's key replaces what
 * it writes. `context.config` is the start-up snapshot, and `context.app` is closed. What it throws fails start-up,
 * naming the route, the router or the controller that set it.
 *
 * It must be synchronous. Replace a nested value rather than mutate one it did not create: an input object is shared by
 * every route it covers.
 */
export type RouteOptionsConfigurer<C = unknown> = (
  options: Partial<RouteOptions>,
  context: HTTPSetupContext<C>,
) => void | undefined

/** A plain object merged key by key over the level's options, or a function that writes them. */
export type RouteOptionsInput<C = unknown> = Partial<RouteOptions> | RouteOptionsConfigurer<C>

/**
 * Sets route options on a method, or on every method of a controller, a method's own key replacing the controller's.
 * Of two stacked on one method, the one written first is applied last, as for every route decorator: its keys win, and
 * objects merge member by member, as within any one level.
 *
 * @example
 * ```ts
 * @Controller('/hooks')
 * @RouteOptions<{ webhooks: { strict: boolean } }>(cors(false), (o, { config }) => {
 *   o.csrf = { exempt: !config.webhooks.strict }
 * })
 * class Hooks {}
 * ```
 */
export function RouteOptions<C = unknown>(...inputs: RouteOptionsInput<C>[]) {
  return (target: Function | object, context: ClassDecoratorContext | ClassMethodDecoratorContext): void => {
    if (context.kind === 'class') {
      configureRouteGroup(context, target as Function, group => group.options(...inputs))
    } else {
      configureRoute(context, route => route.options(...inputs))
    }
  }
}

/** The options of a request no route matched, and of a route that set none. */
export const kNoRouteOptions: Readonly<Partial<RouteOptions>> = Object.freeze({})

/**
 * Folds one level's inputs, in order, onto a fresh object.
 *
 * @throws ErrConfiguration when a configurer throws or returns a promise.
 */
export function applyRouteOptions(
  inputs: readonly RouteOptionsInput[],
  context: HTTPSetupContext,
  owner: string,
): Partial<RouteOptions> {
  const target: Record<PropertyKey, unknown> = {}

  for (const input of inputs) {
    if (typeof input === 'function') {
      let result: unknown
      try {
        result = input(target as Partial<RouteOptions>, context)
      } catch (err) {
        const failure = new ErrConfiguration(
          errMessage(`Cannot apply the route options of "${owner}": ${reasonOf(err)}`)
            .reference('@caffeinejs/http', ErrConfiguration)
            .build(),
        )
        failure.cause = err
        throw failure
      }

      if (isThenable(result)) {
        // Observed, so the rejection it may still make is not reported as unhandled over this refusal.
        Promise.resolve(result).catch(() => undefined)

        throw new ErrConfiguration(
          errMessage(`Cannot apply the route options of "${owner}": a configurer returned a promise`)
            .solutions('Make the configurer synchronous: route options resolve while routes compile')
            .reference('@caffeinejs/http', ErrConfiguration)
            .build(),
        )
      }

      continue
    }

    mergeInto(target, input)
  }

  return target as Partial<RouteOptions>
}

/** One router's or controller's route options, as a group carries them: its inputs, and whose they are. */
export interface RouteOptionsLevel {
  readonly inputs: readonly RouteOptionsInput[]
  /** The router or controller that set them, named in a failure; the compiled group's name when unset. */
  readonly owner?: string
}

/**
 * Folds each level on its own, then lays them over each other, outermost first, a later level's key replacing. A level
 * already in `resolved` is not folded again, so a router's configurer runs once per mount, shared by every group nested
 * under it.
 */
export function resolveRouteOptionLevels(
  levels: readonly RouteOptionsLevel[],
  context: HTTPSetupContext,
  owner: string,
  resolved: WeakMap<RouteOptionsLevel, Partial<RouteOptions>>,
): Partial<RouteOptions> {
  let layered: Partial<RouteOptions> = {}
  for (const level of levels) {
    let own = resolved.get(level)
    if (own === undefined) {
      own = applyRouteOptions(level.inputs, context, level.owner ?? owner)
      resolved.set(level, own)
    }

    layered = layerRouteOptions(layered, own)
  }

  return layered
}

/** Lays `over` on a copy of `base`: a key of `over` replaces the same key of `base`, except two Maps, merged by key. */
export function layerRouteOptions(
  base: Readonly<Partial<RouteOptions>>,
  over: Readonly<Partial<RouteOptions>>,
): Partial<RouteOptions> {
  const layered: Record<PropertyKey, unknown> = { ...base }
  const values = over as Record<PropertyKey, unknown>

  for (const key of ownKeys(values)) {
    // Assigned, an own `__proto__` key a configurer left would become the prototype of the route's options.
    if (key === '__proto__') {
      continue
    }

    const outer = layered[key]
    const inner = values[key]
    layered[key] = outer instanceof Map && inner instanceof Map ? mergeValue(outer, inner) : inner
  }

  return layered as Partial<RouteOptions>
}

// The first line of what a configurer threw: a footer it carries would repeat the failure's own. A value that cannot be
// turned into a string is described instead, so the failure still names the route.
function reasonOf(err: unknown): string {
  try {
    return asError(err).message.split('\n')[0]!
  } catch {
    return 'it threw a value that cannot be printed'
  }
}
