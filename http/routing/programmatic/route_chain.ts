import {
  $i,
  type InjectedOf,
  type InjectionHelpers,
  type InjectionToken,
  type ObjectInjectionSpec,
} from '@caffeinejs/di'

import type { ErrorHandlerRef } from '../../error/error.js'
import type { Guard } from '../../guards/guard.js'
import type { RouteValidationSchema } from '../../route.js'
import type { RouteDetail } from '../detail.js'
import type { RouteAuthzOptions } from '../spec.js'
import type { RouteState } from './_state.js'
import type { RouteExtension } from './extension.js'
import type { Router } from './router.js'
import type { DeclaredRoute, JoinPath, MergeDeps, RouteHandler } from './types.js'

/**
 * One route, mid-declaration.
 *
 * Opened by a verb method on a {@link Router} and closed by {@link handler}, which returns the group so the next
 * route can be chained off it. Every call re-types the chain: a `schema` narrows the context, an `inject` widens
 * the dependencies, and the handler is checked against both.
 */
export class RouteChain<
  S extends RouteValidationSchema,
  P extends string,
  D,
  V,
  C,
  GD,
  GP extends string,
  M extends string,
  R,
> {
  readonly #owner: Router<V, C, GD, GP, R>
  readonly #state: RouteState

  constructor(owner: Router<V, C, GD, GP, R>, state: RouteState) {
    this.#owner = owner
    this.#state = state
  }

  /**
   * Declares what the route validates, and with it what the handler's context is typed as.
   *
   * Same contract as `@Schema`: each slot is compiled to JSON Schema once, at registration, and the adapter's
   * validator does the request-time work.
   */
  schema<S2 extends RouteValidationSchema>(schema: S2): RouteChain<S2, P, D, V, C, GD, GP, M, R> {
    this.#state.builder.schema(schema)
    return this as unknown as RouteChain<S2, P, D, V, C, GD, GP, M, R>
  }

  /**
   * Declares the dependencies handed to the handler as its second argument, keyed by the name the handler reads
   * them under. Values are container keys or any `$i` helper, and the handler's `deps` is typed from them.
   *
   * Merged over whatever the enclosing groups injected, so a route may take a group's name for a different
   * binding.
   *
   * A function is handed `$i`, so a route reaching for `optional`, `allOf`, `provide` or `value` does not have to
   * import it. Both forms produce the same dependencies and type the handler the same way, but only the function
   * form types `$i.value`: the `$i` imported for the object form cannot know which application it is in, so a
   * selector there reads `unknown` unless the call names the type itself.
   *
   * ```ts
   * pets.get('/:id').inject($i => ({ tracer: $i.provide(Tracer) }))
   * ```
   */
  inject<const SPEC extends ObjectInjectionSpec>(
    spec: SPEC,
  ): RouteChain<S, P, MergeDeps<D, InjectedOf<SPEC>>, V, C, GD, GP, M, R>
  inject<const SPEC extends ObjectInjectionSpec>(
    build: (i: InjectionHelpers<C>) => SPEC,
  ): RouteChain<S, P, MergeDeps<D, InjectedOf<SPEC>>, V, C, GD, GP, M, R>
  inject(specOrBuild: ObjectInjectionSpec | ((i: InjectionHelpers) => ObjectInjectionSpec)): any {
    const spec = typeof specOrBuild === 'function' ? specOrBuild($i) : specOrBuild

    this.#state.injection = { ...this.#state.injection, ...spec }

    return this
  }

  /** The route's identity within its group: the OpenAPI operation name, and what diagnostics call it. */
  name(name: string): this {
    this.#state.builder.name(name)
    this.#state.named = true
    return this
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

  status(code: number): this {
    this.#state.builder.statusCode(code)
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

  config<K extends string>(key: K, value: unknown): this
  config<K extends string>(config: Map<K, unknown>): this
  config<K extends string>(keyOrConfig: K | Map<K, unknown>, value?: unknown): this {
    this.#state.builder.config(keyOrConfig as K, value)
    return this
  }

  /** Where a package attaches its own per-route metadata, under the namespace it owns. */
  detail<K extends keyof RouteDetail>(key: K, value: RouteDetail[K]): this {
    this.#state.builder.detail(key, value)
    return this
  }

  /**
   * Applies extensions to the route, in the order given.
   *
   * How a package configures a route it does not own: `@caffeinejs/openapi` documenting an operation,
   * `compress()` setting compression, Fastify's own route options through `fst`. An extension is the
   * same function a decorator passes to `configureRoute`, so a feature reads the same whichever way the route
   * was declared.
   *
   * ```ts
   * pets.get('/:id').with(operation({ summary: 'Get a pet' }), compress({ threshold: 1024 }))
   * ```
   */
  with(extension: RouteExtension, ...rest: RouteExtension[]): this {
    extension(this.#state.builder)

    for (const ext of rest) {
      ext(this.#state.builder)
    }

    return this
  }

  /**
   * Sets the function the route calls, closing the chain and returning the group.
   *
   * The handler takes the context first and the injected dependencies second — `undefined` when neither the route
   * nor any group above it injected anything.
   *
   * The group comes back carrying this route in its type, which is what `RoutesOf` reads back. Chaining the next
   * route off it accumulates the router's whole surface; keeping the returned values as separate variables and
   * combining them with `blend` arrives at the same type.
   */
  handler<O>(
    fn: RouteHandler<S, JoinPath<GP, P>, V, C, D, O>,
  ): Router<V, C, GD, GP, R | DeclaredRoute<M, JoinPath<GP, P>, S, O>> {
    this.#state.handle = fn as (...args: unknown[]) => unknown
    return this.#owner as Router<V, C, GD, GP, R | DeclaredRoute<M, JoinPath<GP, P>, S, O>>
  }
}
