import { errMessage } from '@caffeinejs/std/err'

import { ErrConfiguration } from '../error/common.js'
import type { RouteOptions } from '../routing/options.js'
import type { IRoute, IRouteGroup } from '../routing/route.js'
import type { HookBatch } from './batch.js'
import { assertHookName, isThenable, REQUEST_HOOK_NAMES, type RequestHookName, type RequestHooks } from './lifecycle.js'

/** Request hooks as written, by point, in the order they were added. */
export type AuthoredHooks = { readonly [K in RequestHookName]?: readonly RequestHooks[K][] }

/**
 * One route as an `onRoute` hook sees it.
 *
 * Everything the route declares is read before `onRoute` runs, so changing `route` or `group` here changes nothing the
 * server does; `route.detail` may be enriched for readers that come later, such as a generated document. What a hook
 * adds for this route alone goes through {@link hook}.
 */
export interface RouteDefinition<R = unknown> {
  /** Upper-case, as declared. The automatic HEAD route of a GET is not listed. */
  readonly methods: readonly string[]
  /** The first path the route serves: the group's prefix included, the application's base path not. */
  readonly url: string
  readonly route: Readonly<IRoute<R>>
  readonly group: Readonly<IRouteGroup<R>>
  /** What the route and its groups set with `config(...)`. */
  readonly options: Readonly<Partial<RouteOptions>>

  /**
   * Adds a hook to this route alone, after every other hook of that point.
   *
   * @throws ErrConfiguration once `onRoute` has returned, and for a point that is not a request hook.
   */
  hook<K extends RequestHookName>(name: K, fn: RequestHooks[K]): this
}

/** A definition still open to `onRoute`: what its hooks added, and how to close it. */
export interface OpenDefinition<R> {
  readonly definition: RouteDefinition<R>
  readonly added: AuthoredHooks
  /** Refuses every later `hook(...)`. */
  close(): void
}

/** Opens the definition `onRoute` hooks are handed for one route. */
export function openDefinition<R>(
  route: IRoute<R>,
  group: IRouteGroup<R>,
  methods: readonly string[],
  url: string,
): OpenDefinition<R> {
  const added: { [K in RequestHookName]?: RequestHooks[K][] } = {}
  let open = true

  const definition: RouteDefinition<R> = {
    methods,
    url,
    route,
    group,
    options: route.options,
    hook<K extends RequestHookName>(name: K, fn: RequestHooks[K]) {
      if (!open) {
        throw new ErrConfiguration(
          errMessage(`Cannot add a hook to "${methods.join('|')} ${url}": onRoute has returned`)
            .solutions('Call route.hook(...) inside the onRoute hook')
            .reference('@caffeinejs/http', ErrConfiguration)
            .build(),
        )
      }

      assertHookName(name, REQUEST_HOOK_NAMES, 'from onRoute')
      ;((added[name] ??= []) as RequestHooks[K][]).push(fn)
      return this
    },
  }

  return {
    definition,
    added,
    close: () => {
      open = false
    },
  }
}

/**
 * Calls every `onRoute` of `batches`, in order, each with its own batch's context.
 *
 * @throws ErrConfiguration when one returns a promise: it runs while routes register, and nothing would wait on it.
 */
export function callOnRoute<R>(batches: readonly HookBatch[], definition: RouteDefinition<R>): void {
  for (const batch of batches) {
    for (const onRoute of batch.onRoute) {
      const result: unknown = onRoute(definition as unknown as RouteDefinition, batch.kit)

      if (isThenable(result)) {
        // Observed, so the rejection the hook may still make is not reported as unhandled over this refusal.
        Promise.resolve(result).catch(() => undefined)

        throw new ErrConfiguration(
          errMessage(
            `Cannot run the onRoute hook for "${definition.methods.join('|')} ${definition.url}": it returned a promise`,
          )
            .solutions('Make onRoute synchronous: it runs while routes register')
            .reference('@caffeinejs/http', ErrConfiguration)
            .build(),
        )
      }
    }
  }
}
