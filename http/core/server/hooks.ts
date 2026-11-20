import { runGuards, type CompiledGuard } from '@caffeinejs/application/framework'

import type { IContext } from '../../context.js'
import { httpGuardDenial, type Guard, type GuardContext, type GuardTarget } from '../guards/guard.js'
import type { HookBatch } from '../lifecycle/batch.js'
import {
  assertHookName,
  callbackEntry,
  REQUEST_HOOK_NAMES,
  type ErrorEntry,
  type HookEntry,
  type RequestHookName,
  type SendEntry,
} from '../lifecycle/lifecycle.js'
import type { AuthoredHooks } from '../lifecycle/route_definition.js'
import { compileChain } from '../middleware/chain.js'
import type { ResolvedMiddleware } from '../middleware/pipeline.js'
import type { CompiledHooks, IRouteGroup } from '../routing/route.js'
import type { Context } from './context.js'
import type { ResolvedServerSettings } from './settings.js'

/** One flat array per request point: what a route runs. */
export interface StoreHooks {
  readonly onRequest: readonly HookEntry<Context>[]
  readonly preHandler: readonly HookEntry<Context>[]
  readonly onSend: readonly SendEntry<Context>[]
  readonly onResponse: readonly HookEntry<Context>[]
  readonly onError: readonly ErrorEntry<Context>[]
}

/** One level in front of routes, the server's root or one scope at one path: its plugins' hooks, then its middleware. */
export interface LevelInput {
  readonly batches: readonly HookBatch[]
  /** Already rebased under the scope's path. */
  readonly middlewares: readonly ResolvedMiddleware[]
}

/**
 * Compiles one level once: each batch's request hooks in batch order, then, per point, one chain of the level's
 * middleware registered at that point.
 *
 * @throws ErrConfiguration for a middleware at a point that is not a request hook.
 */
export function compileLevel(level: LevelInput, settings: ResolvedServerSettings): StoreHooks {
  const hooks = empty()

  for (const batch of level.batches) {
    for (const point of REQUEST_HOOK_NAMES) {
      push(hooks, point, batch.request[point] as readonly ((...args: never[]) => unknown)[])
    }
  }

  const byPoint = new Map<RequestHookName, ResolvedMiddleware[]>()
  for (const middleware of level.middlewares) {
    const point = middleware.hook ?? 'onRequest'
    assertHookName(point, REQUEST_HOOK_NAMES, `for a middleware on the ${settings.application}`)

    let list = byPoint.get(point)
    if (list === undefined) {
      list = []
      byPoint.set(point, list)
    }
    list.push(middleware)
  }

  for (const point of REQUEST_HOOK_NAMES) {
    const chain = compileChain<Context>(byPoint.get(point) ?? [], point)

    if (chain !== undefined) {
      // A chain at a later point ignores the payload or the error, and keeps the payload.
      ;(hooks[point] as unknown[]).push(
        point === 'onSend' || point === 'onError' ? (ctx: Context) => chain(ctx) : chain,
      )
    }
  }

  return hooks
}

/**
 * A route's hooks in the program's fixed order: the server's root level, each scope outermost first, the group's own
 * `onRequest` and the guards, the route's compiled hooks, then what `onRoute` added.
 */
export function composeRouteHooks(input: {
  readonly root: StoreHooks
  readonly scopes: readonly StoreHooks[]
  readonly group: IRouteGroup<Context>
  readonly guards: readonly CompiledGuard<Guard>[] | undefined
  readonly target: GuardTarget
  readonly compiled: CompiledHooks<Context> | undefined
  readonly added: AuthoredHooks
}): StoreHooks {
  const { added } = input

  // Nothing of the route's own: it runs the server's hooks, shared rather than copied.
  if (
    input.scopes.length === 0 &&
    input.group.onRequest === undefined &&
    !input.guards?.length &&
    input.compiled === undefined &&
    REQUEST_HOOK_NAMES.every(point => !added[point]?.length)
  ) {
    return input.root
  }

  const hooks = empty()

  for (const level of [input.root, ...input.scopes]) {
    for (const point of REQUEST_HOOK_NAMES) {
      ;(hooks[point] as unknown[]).push(...level[point])
    }
  }

  const groupHook = input.group.onRequest
  if (groupHook !== undefined) {
    hooks.onRequest.push(callbackEntry<Context>((ctx, done) => groupHook(ctx, ctx, done)))
  }

  const guards = input.guards
  if (guards !== undefined && guards.length > 0) {
    const target = input.target

    hooks.onRequest.push(
      callbackEntry<Context>((ctx, done) =>
        runGuards(guards, { kind: 'http', context: ctx as unknown as GuardContext, target }, httpGuardDenial, done),
      ),
    )
  }

  const compiled = input.compiled
  if (compiled !== undefined) {
    for (const point of REQUEST_HOOK_NAMES) {
      // The engine's context is also the request the route is compiled against.
      for (const entry of compiled[point] as readonly ((req: Context, ctx: IContext, arg: unknown) => unknown)[]) {
        ;(hooks[point] as unknown[]).push((ctx: Context, arg: unknown) => entry(ctx, asIContext(ctx), arg))
      }
    }
  }

  for (const point of REQUEST_HOOK_NAMES) {
    push(hooks, point, (added[point] ?? []) as readonly ((...args: never[]) => unknown)[])
  }

  return hooks
}

type Mutable = { [K in keyof StoreHooks]: StoreHooks[K] extends readonly (infer E)[] ? E[] : never }

function empty(): Mutable {
  return { onRequest: [], preHandler: [], onSend: [], onResponse: [], onError: [] }
}

// Hooks written against `IContext`, called with the engine's context.
function push(hooks: Mutable, point: RequestHookName, fns: readonly ((...args: never[]) => unknown)[]): void {
  ;(hooks[point] as unknown[]).push(...fns)
}

// Handed to code typed on `IContext`.
function asIContext(ctx: Context): IContext {
  return ctx as unknown as IContext
}
