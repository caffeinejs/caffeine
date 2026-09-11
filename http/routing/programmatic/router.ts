import {
  $i,
  type InjectedOf,
  type InjectionHelpers,
  type InjectionToken,
  type ObjectInjectionSpec,
} from '@caffeinejs/di'
import type { Feature } from '@caffeinejs/std'

import { VERSION_CONSTRAINT } from '../../constraints/registry.js'
import type { ErrorHandlerRef } from '../../error/error.js'
import type { Guard } from '../../guards/guard.js'
import type { BuilderOf } from '../../plugin.js'
import type { RouteValidationSchema } from '../../route.js'
import { RouteBuilder, RouteGroupBuilder } from '../builder.js'
import type { RouteAuthzOptions } from '../spec.js'
import { attachState, stateOf, type RouterState } from './_state.js'
import type { RouteGroupExtension } from './extension.js'
import { RouteChain } from './route_chain.js'
import type { DeclaredRoute, JoinPath, MergeDeps, PrefixRoutePaths, RouteHandler, RoutesOf } from './types.js'

const ALL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

/** What `all()` answers, as a type. */
type AllMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

/**
 * A group of routes, written as code rather than declared on a class.
 *
 * A router is inert: it records what its routes are and how they are configured, and does nothing until an
 * application mounts it. Once mounted, its routes go through the same compilation a `@Controller`'s do, so they
 * get the same authentication, authorization, guards, error handling and validation.
 *
 * ```ts
 * const pets = new Router('/pets')
 *   .inject({ svc: PetService })
 *
 * pets
 *   .get('/:id')
 *   .schema({ params: $t.Object({ id: $t.Integer() }) })
 *   .handler((ctx, deps) => deps.svc.find(ctx.req.param().id))
 *
 * app.mount(pets)
 * ```
 *
 * Declared as a chain — `router.get('/a').handler(f).get('/b').handler(g)` — the router's type accumulates a
 * descriptor per route, which is what a generated client reads. See {@link RoutesOf}.
 */
export class Router<
  V = Record<never, never>,
  C = Record<never, never>,
  GD = undefined,
  GP extends string = '',
  R = never,
> {
  /** Phantom — names the routes this router declares, for `RoutesOf`. Never assigned, never read. */
  declare readonly __routes?: R

  /** Phantom — names what `ctx.state` carries under this router, for `VarsOf`. Never assigned, never read. */
  declare readonly __vars?: V

  /** Phantom — names what `ctx.config` is typed as under this router. Never assigned, never read. */
  declare readonly __config?: C

  /** Phantom — names what this router's `inject()` declared, for `DepsOf`. Never assigned, never read. */
  declare readonly __deps?: GD

  readonly #state: RouterState

  constructor(path: GP = '' as GP) {
    this.#state = {
      builder: new RouteGroupBuilder(),
      path,
      routes: [],
      children: [],
      installs: [],
    }

    attachState(this, this.#state)
  }

  /**
   * The group's identity: the OpenAPI tag and the prefix of its operation names, and what diagnostics call it.
   * Defaults to the group's path in Pascal case.
   */
  name(name: string): this {
    this.#state.name = name
    return this
  }

  /**
   * Declares what `ctx.state` carries for every route of the group and of the groups nested under it.
   *
   * ```ts
   * const pets = new Router('/pets/:petID').vars<{ tenant: Tenant }>()
   *
   * pets.get('/:id').handler(ctx => ctx.state.get('tenant'))
   * ```
   *
   * Written as a call rather than `new Router<Vars>(path)` because naming one type argument stops the compiler
   * inferring the rest, which would drop the group's path and with it the handler's parameter types.
   */
  vars<V2>(): Router<V2, C, GD, GP, R> {
    return this as unknown as Router<V2, C, GD, GP, R>
  }

  /**
   * Declares what `ctx.config` is typed as for every route of the group and of the groups nested under it, and
   * what an `.inject()` callback's `$i.value` selector reads from.
   *
   * ```ts
   * const pets = new Router('/pets').configType<AppConfig>()
   *
   * pets.get('/').handler(ctx => ctx.config.catalog.pageSize)
   * ```
   *
   * Only the type: the values come from the application's own configuration either way. Named apart from
   * {@link config}, which writes the adapter's per-route configuration.
   */
  configType<C2>(): Router<V, C2, GD, GP, R> {
    return this as unknown as Router<V, C2, GD, GP, R>
  }

  /**
   * Declares dependencies for every route of the group and of the groups nested under it, keyed by the name the
   * handlers read them under. Values are container keys or any `$i` helper.
   *
   * A function is handed `$i`, so a group reaching for `optional`, `allOf`, `provide` or `value` does not have to
   * import it. Both forms produce the same dependencies and type the handler the same way, but only the function
   * form types `$i.value`: the `$i` imported for the object form cannot know which application it is in, so a
   * selector there reads `unknown` unless the call names the type itself.
   *
   * ```ts
   * new Router('/pets').inject($i => ({ svc: PetService, audit: $i.optional(Audit) }))
   * ```
   */
  inject<const SPEC extends ObjectInjectionSpec>(spec: SPEC): Router<V, C, MergeDeps<GD, InjectedOf<SPEC>>, GP, R>
  inject<const SPEC extends ObjectInjectionSpec>(
    build: (i: InjectionHelpers<C>) => SPEC,
  ): Router<V, C, MergeDeps<GD, InjectedOf<SPEC>>, GP, R>
  inject(specOrBuild: ObjectInjectionSpec | ((i: InjectionHelpers) => ObjectInjectionSpec)): any {
    const spec = typeof specOrBuild === 'function' ? specOrBuild($i) : specOrBuild

    this.#state.injection = { ...this.#state.injection, ...spec }

    return this
  }

  /**
   * Nests a group under this one. The child inherits this group's configuration and dependencies, and may add or
   * override its own.
   */
  group<CP extends string, CR>(
    path: CP,
    configure: (router: Router<V, C, GD, JoinPath<GP, CP>>) => Router<any, any, any, any, CR>,
  ): Router<V, C, GD, GP, R | CR>
  group<CP extends string>(path: CP, configure: (router: Router<V, C, GD, JoinPath<GP, CP>>) => unknown): this
  group<CP extends string>(path: CP, configure: (router: Router<V, C, GD, JoinPath<GP, CP>>) => unknown): this {
    const child = new Router<V, C, GD, JoinPath<GP, CP>>(path as unknown as JoinPath<GP, CP>)
    configure(child)
    this.#state.children.push(stateOf(child)!)
    return this
  }

  /**
   * Nests independently declared routers under this one, optionally beneath an extra path segment.
   *
   * Composition, as opposed to {@link group}: a mounted router was written elsewhere and keeps its own routes
   * and configuration, inheriting this group's on top.
   *
   * Mounting the same router twice adds it once — which is what makes routes declared as separate statements
   * mountable, since every value `.handler()` returns names the one router it was opened from.
   */
  mount<MP extends string, const RS extends ReadonlyArray<Router<any, any, any, any, any>>>(
    path: MP,
    ...routers: RS
  ): Router<V, C, GD, GP, R | PrefixRoutePaths<RoutesOf<RS[number]>, JoinPath<GP, MP>>>
  mount<const RS extends ReadonlyArray<Router<any, any, any, any, any>>>(
    ...routers: RS
  ): Router<V, C, GD, GP, R | PrefixRoutePaths<RoutesOf<RS[number]>, GP>>
  mount(...args: Array<string | Router<any, any, any, any, any>>): this {
    const path = typeof args[0] === 'string' ? args[0] : ''
    const routers = (path === '' ? args : args.slice(1)) as Array<Router<any, any, any, any, any>>

    for (const router of routers) {
      const state = stateOf(router)!

      this.#adopt(path === '' ? state : { ...state, path: `${path}${state.path}` })
    }

    return this
  }

  /**
   * Declares a route, either opening a chain to configure it or closing it there and then.
   *
   * Given a handler the route is complete, and what comes back is the group rather than the chain — so the next
   * route is written straight off it. A schema before the handler types the context the handler receives; without
   * one the path still types `ctx.req.param()`.
   *
   * ```ts
   * pets
   *   .get('/', (ctx, deps) => deps.svc.all())
   *   .get('/:id', { params: $t.Object({ id: $t.Integer() }) }, (ctx, deps) => deps.svc.find(ctx.req.param().id))
   * ```
   *
   * The chain is what a route needing a name, guards, authorization or an extension is written with: the inline
   * form closes the route immediately, so there is nothing left to hang those on.
   */
  get<P extends string>(path: P): Chain<'GET', P, V, C, GD, GP, R>
  get<P extends string, O>(
    path: P,
    handler: Handler<Empty, P, V, C, GD, GP, O>,
  ): Closed<'GET', P, Empty, O, V, C, GD, GP, R>
  get<P extends string, S extends RouteValidationSchema, O>(
    path: P,
    schema: S,
    handler: Handler<S, P, V, C, GD, GP, O>,
  ): Closed<'GET', P, S, O, V, C, GD, GP, R>
  get(path: string, schemaOrHandler?: unknown, handler?: unknown): any {
    return this.#route(['GET'], path, schemaOrHandler, handler)
  }

  post<P extends string>(path: P): Chain<'POST', P, V, C, GD, GP, R>
  post<P extends string, O>(
    path: P,
    handler: Handler<Empty, P, V, C, GD, GP, O>,
  ): Closed<'POST', P, Empty, O, V, C, GD, GP, R>
  post<P extends string, S extends RouteValidationSchema, O>(
    path: P,
    schema: S,
    handler: Handler<S, P, V, C, GD, GP, O>,
  ): Closed<'POST', P, S, O, V, C, GD, GP, R>
  post(path: string, schemaOrHandler?: unknown, handler?: unknown): any {
    return this.#route(['POST'], path, schemaOrHandler, handler)
  }

  put<P extends string>(path: P): Chain<'PUT', P, V, C, GD, GP, R>
  put<P extends string, O>(
    path: P,
    handler: Handler<Empty, P, V, C, GD, GP, O>,
  ): Closed<'PUT', P, Empty, O, V, C, GD, GP, R>
  put<P extends string, S extends RouteValidationSchema, O>(
    path: P,
    schema: S,
    handler: Handler<S, P, V, C, GD, GP, O>,
  ): Closed<'PUT', P, S, O, V, C, GD, GP, R>
  put(path: string, schemaOrHandler?: unknown, handler?: unknown): any {
    return this.#route(['PUT'], path, schemaOrHandler, handler)
  }

  patch<P extends string>(path: P): Chain<'PATCH', P, V, C, GD, GP, R>
  patch<P extends string, O>(
    path: P,
    handler: Handler<Empty, P, V, C, GD, GP, O>,
  ): Closed<'PATCH', P, Empty, O, V, C, GD, GP, R>
  patch<P extends string, S extends RouteValidationSchema, O>(
    path: P,
    schema: S,
    handler: Handler<S, P, V, C, GD, GP, O>,
  ): Closed<'PATCH', P, S, O, V, C, GD, GP, R>
  patch(path: string, schemaOrHandler?: unknown, handler?: unknown): any {
    return this.#route(['PATCH'], path, schemaOrHandler, handler)
  }

  delete<P extends string>(path: P): Chain<'DELETE', P, V, C, GD, GP, R>
  delete<P extends string, O>(
    path: P,
    handler: Handler<Empty, P, V, C, GD, GP, O>,
  ): Closed<'DELETE', P, Empty, O, V, C, GD, GP, R>
  delete<P extends string, S extends RouteValidationSchema, O>(
    path: P,
    schema: S,
    handler: Handler<S, P, V, C, GD, GP, O>,
  ): Closed<'DELETE', P, S, O, V, C, GD, GP, R>
  delete(path: string, schemaOrHandler?: unknown, handler?: unknown): any {
    return this.#route(['DELETE'], path, schemaOrHandler, handler)
  }

  head<P extends string>(path: P): Chain<'HEAD', P, V, C, GD, GP, R>
  head<P extends string, O>(
    path: P,
    handler: Handler<Empty, P, V, C, GD, GP, O>,
  ): Closed<'HEAD', P, Empty, O, V, C, GD, GP, R>
  head<P extends string, S extends RouteValidationSchema, O>(
    path: P,
    schema: S,
    handler: Handler<S, P, V, C, GD, GP, O>,
  ): Closed<'HEAD', P, S, O, V, C, GD, GP, R>
  head(path: string, schemaOrHandler?: unknown, handler?: unknown): any {
    return this.#route(['HEAD'], path, schemaOrHandler, handler)
  }

  options<P extends string>(path: P): Chain<'OPTIONS', P, V, C, GD, GP, R>
  options<P extends string, O>(
    path: P,
    handler: Handler<Empty, P, V, C, GD, GP, O>,
  ): Closed<'OPTIONS', P, Empty, O, V, C, GD, GP, R>
  options<P extends string, S extends RouteValidationSchema, O>(
    path: P,
    schema: S,
    handler: Handler<S, P, V, C, GD, GP, O>,
  ): Closed<'OPTIONS', P, S, O, V, C, GD, GP, R>
  options(path: string, schemaOrHandler?: unknown, handler?: unknown): any {
    return this.#route(['OPTIONS'], path, schemaOrHandler, handler)
  }

  /** Every method the adapter routes, for a path that answers all of them. */
  all<P extends string>(path: P): Chain<AllMethod, P, V, C, GD, GP, R>
  all<P extends string, O>(
    path: P,
    handler: Handler<Empty, P, V, C, GD, GP, O>,
  ): Closed<AllMethod, P, Empty, O, V, C, GD, GP, R>
  all<P extends string, S extends RouteValidationSchema, O>(
    path: P,
    schema: S,
    handler: Handler<S, P, V, C, GD, GP, O>,
  ): Closed<AllMethod, P, S, O, V, C, GD, GP, R>
  all(path: string, schemaOrHandler?: unknown, handler?: unknown): any {
    return this.#route([...ALL_METHODS], path, schemaOrHandler, handler)
  }

  /** The escape hatch for a method the verb helpers do not name, or for one route answering a chosen few. */
  route<M extends string, P extends string>(method: M | M[], path: P): Chain<M, P, V, C, GD, GP, R>
  route<M extends string, P extends string, O>(
    method: M | M[],
    path: P,
    handler: Handler<Empty, P, V, C, GD, GP, O>,
  ): Closed<M, P, Empty, O, V, C, GD, GP, R>
  route<M extends string, P extends string, S extends RouteValidationSchema, O>(
    method: M | M[],
    path: P,
    schema: S,
    handler: Handler<S, P, V, C, GD, GP, O>,
  ): Closed<M, P, S, O, V, C, GD, GP, R>
  route(method: string | string[], path: string, schemaOrHandler?: unknown, handler?: unknown): any {
    return this.#route(Array.isArray(method) ? method : [method], path, schemaOrHandler, handler)
  }

  authorize(options: RouteAuthzOptions): this {
    this.#state.builder.authorize(options)
    return this
  }

  guards(guards: InjectionToken<Guard>[]): this {
    this.#state.builder.guards(guards)
    return this
  }

  catchBy(handlers: ErrorHandlerRef[]): this {
    this.#state.builder.catchBy(handlers)
    return this
  }

  header(name: string, value: string | string[]): this {
    this.#state.builder.header(name, value)
    return this
  }

  consumes(consumes: string | string[]): this {
    this.#state.builder.consumes(consumes)
    return this
  }

  produces(produces: string): this {
    this.#state.builder.produces(produces)
    return this
  }

  bodyLimit(bytes: number): this {
    this.#state.builder.bodyLimit(bytes)
    return this
  }

  timeout(ms: number): this {
    this.#state.builder.timeout(ms)
    return this
  }

  /** The adapter's per-route configuration, as `@Config` writes it. */
  config<K extends string>(key: K, value: unknown): this
  config<K extends string>(config: Map<K, unknown>): this
  config<K extends string>(keyOrConfig: K | Map<K, unknown>, value?: unknown): this {
    this.#state.builder.config(keyOrConfig as K, value)
    return this
  }

  /** Where a package attaches its own per-group metadata, keyed by a symbol it owns. */
  extras<K extends symbol>(key: K, value: unknown): this
  extras<K extends symbol>(extras: Map<K, unknown>): this
  extras<K extends symbol>(keyOrExtras: K | Map<K, unknown>, value?: unknown): this {
    this.#state.builder.extras(keyOrExtras as K, value)
    return this
  }

  /**
   * Selects every route of the group on a registered route constraint. A route setting the same constraint
   * overrides this one. `name` must be registered — `version` always is, others through `app.constraints(...)`.
   */
  constraint(name: string, value: unknown): this {
    this.#state.builder.constraint(name, value)
    return this
  }

  /**
   * Binds every route of the group to an API version, selected by the `Accept-Version` request header. A route
   * calling `.version()` overrides it. Sugar for `.constraint('version', version)`.
   */
  version(version: string): this {
    this.#state.builder.constraint(VERSION_CONSTRAINT, version)
    return this
  }

  /**
   * Installs a feature whose plugin is registered inside this group's Fastify context.
   *
   * The same features the application takes, scoped: `router.extend(cors('pets'), c => …)` puts the plugin in
   * front of this group's routes and the groups nested under it, and nowhere else. The feature itself is
   * installed on the application, so it declares its configuration and bootstraps exactly once — installing
   * the same {@link Feature.name} here and on the application is the duplicate it looks like. Two routers
   * wanting different settings install two instances of the feature (`cors()` and `cors('pets')`).
   *
   * The configure callback is not re-typed against the application's configuration the way the builder's
   * `.extend` is: a router is written without knowing which application it will be mounted into, so a
   * `.config(c => …)` selector here sees `unknown`.
   *
   * Routing is built during start-up, so this has to be called before the application is ready.
   *
   * ```ts
   * const pets = new Router('/pets').extend(cors('pets'), c => c.origin('https://pets.example'))
   * ```
   */
  extend<F extends Feature>(feature: F, configure?: (builder: BuilderOf<F>) => void): this {
    this.#state.installs.push({ feature, configure: configure as ((builder: never) => void) | undefined })
    return this
  }

  /**
   * Applies extensions to the group, in the order given. They reach every route under it, nested groups included.
   *
   * ```ts
   * const pets = new Router('/pets').with(apiGroup({ name: 'Pets' }))
   * ```
   */
  with(extension: RouteGroupExtension, ...rest: RouteGroupExtension[]): this {
    extension(this.#state.builder)

    for (const ext of rest) {
      ext(this.#state.builder)
    }

    return this
  }

  // Siblings only: two children of the same group start from the same path, so the same state twice is the same
  // routes twice. A state shared between *different* parents resolves to different paths and is kept.
  #adopt(state: RouterState): void {
    if (this.#state.children.includes(state)) {
      return
    }

    this.#state.children.push(state)
  }

  // The inline forms are the chain, called on the caller's behalf: one registration path, so a schema declared
  // inline and one declared with `.schema()` cannot compile differently.
  #route(method: string[], path: string, schemaOrHandler: unknown, handler: unknown): unknown {
    const state = {
      builder: new RouteBuilder(),
      method,
      path,
      named: false,
    }

    this.#state.routes.push(state)

    // The overloads carry the real types; inside, every one of them is an unresolved parameter, so the chain is
    // held loosely rather than threaded through a signature no caller ever sees.
    const chain: AnyRouteChain = new RouteChain(this, state)

    if (schemaOrHandler === undefined) {
      return chain
    }

    if (typeof schemaOrHandler === 'function') {
      return chain.handler(schemaOrHandler as AnyRouteHandler)
    }

    return chain.schema(schemaOrHandler as RouteValidationSchema).handler(handler as AnyRouteHandler)
  }
}

/** A route that has declared no schema yet: every slot falls back to what the path and the adapter give. */
type Empty = Record<never, never>

type AnyRouteChain = RouteChain<any, any, any, any, any, any, any, any, any>

type AnyRouteHandler = RouteHandler<any, any, any, any, any>

/** What a verb answers when it was given no handler: the route, still open for configuration. */
type Chain<M extends string, P extends string, V, C, GD, GP extends string, R> = RouteChain<
  Empty,
  P,
  GD,
  V,
  C,
  GD,
  GP,
  M,
  R
>

/** What a verb answers when a handler closed the route there and then: the group, carrying the route. */
type Closed<
  M extends string,
  P extends string,
  S extends RouteValidationSchema,
  O,
  V,
  C,
  GD,
  GP extends string,
  R,
> = Router<V, C, GD, GP, R | DeclaredRoute<M, JoinPath<GP, P>, S, O>>

/** A handler written inline on a verb, typed against the route's schema and its full path. */
type Handler<S extends RouteValidationSchema, P extends string, V, C, GD, GP extends string, O> = RouteHandler<
  S,
  JoinPath<GP, P>,
  V,
  C,
  GD,
  O
>
