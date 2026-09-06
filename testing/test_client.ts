import { brewer, type BrewClient, type BrewOptions } from '@caffeinejs/brewer'
import type { Container } from '@caffeinejs/di'
import { Router, type DepsOf } from '@caffeinejs/http'

import { Harness, type AnyRouter, type TestApplication, type TestApplicationBuilder } from './_test_app.js'
import { ErrTestClientTarget } from './error.js'

/** How the client shapes the requests it sends. */
export interface FetchOptions {
  /**
   * Applied to every request the client makes.
   *
   * `method` and `body` are ignored: the route and the call decide those. `headers` are sent with every request
   * and a per-call `headers` wins over them, so a token that changes between assertions belongs on the call.
   */
  init?: RequestInit
}

/** What a client over any target takes. */
export interface AppTestClientOptions<D> extends FetchOptions {
  /**
   * Replaces dependencies by the name the handlers read them under, rather than by the container key they were
   * declared with.
   *
   * ```ts
   * const client = testClient(users, { inject: { userRepository: mock } })
   * ```
   *
   * The name is the one `.inject()` gave it, so every route reached through this client that declares that name
   * sees the replacement — including routes of a second router mounted alongside.
   *
   * A name the target never declared is rejected. Its value is typed `D[K] | object`, as `overrideWithMock` types
   * a mock, so a partial fake or a `vi.fn()` bag goes in without a double assertion.
   */
  inject?: Injectable<D>

  /** Binds into the container before the application is readied. */
  bind?: (container: Container) => void
}

/** What a client over routers additionally takes, since it is the one building their application. */
export interface TestClientOptions<D> extends AppTestClientOptions<D> {
  /** The container the routers resolve against — a `newTestContainer()` build, or any other. */
  container?: Container

  /** The application builder, before it is built: authentication, authorization, guards, cache, features. */
  configure?: (builder: TestApplicationBuilder) => void
}

/** What the client offers besides the routes: the application it drives, and its lifecycle. */
export interface TestClientControls {
  /** The application behind the client. Still configurable until the first request readies it. */
  readonly $app: TestApplication

  readonly $container: Container

  /** A request by path rather than by route, for whatever the typed surface cannot say. */
  $fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>

  /** Readies the application. Called for you by the first request; here for a test that wants it earlier. */
  $ready(): Promise<void>

  /** Closes the application — the one it built, or the one it was given. */
  $close(): Promise<void>

  [Symbol.asyncDispose](): Promise<void>
}

/**
 * What may be replaced, by the name the handlers read it under.
 *
 * A target that injected nothing is spelled `Record<string, never>` rather than the empty object it reduces to,
 * because every object literal is assignable to `{}` — so the empty case would accept any name at all.
 */
type Injectable<D> = [keyof D] extends [never] ? Record<string, never> : { [K in keyof D]?: D[K] | object }

/** A {@link brewer} client over a local application, plus the controls that application needs. */
export type TestClient<T> = BrewClient<T> & TestClientControls

/** Anything that answers requests the way an application does. */
interface Fetchable {
  fetch(input: Request | string | URL, options?: RequestInit): Promise<Response>
}

/**
 * A typed client for an application or the routers it would mount, wired and torn down by the test.
 *
 * Routes are reached the way {@link brewer} reaches them — property access for a segment, a call for a path
 * parameter, a verb to send — and typed from the target, so nothing describes the API twice.
 *
 * ```ts
 * const client = testClient(pets)
 *
 * const res = await client.pets({ id: 1 }).get()
 * expect(res.status).toBe(200)
 * ```
 *
 * Given routers rather than an application, one is built around them: they are mounted into a container of their
 * own, so a `@Controller` declared elsewhere in the test file is not routed and the routers under test are the
 * whole surface. Dependencies come from `inject`, `bind` or `container`, and everything else from `configure`.
 *
 * ```ts
 * const client = testClient([pets, orders], {
 *   inject: { repository: fake },
 *   configure: builder => builder.authentication(auth => auth.scheme(bearer)),
 * })
 * ```
 *
 * The application is readied by the first request, not by this call — which is what keeps `$app` open to
 * configuration a moment longer:
 *
 * ```ts
 * const client = testClient(pets)
 * client.$app.use(RequestLogger)
 * await client.pets.get()
 * ```
 *
 * A failing status resolves rather than throwing, as it does through `brewer`: the status is part of what a test
 * asserts on. Close with `$close()`, or bind the client with `await using`.
 *
 * @throws ErrTestClientTarget - The target is neither an application nor at least one router.
 * @throws ErrTestClientAlreadyReady - `inject` or `bind` was given for an application that is already ready.
 */
export function testClient<T extends Fetchable>(app: T, options?: AppTestClientOptions<DepsOf<T>>): TestClient<T>
export function testClient<R extends AnyRouter>(router: R, options?: TestClientOptions<DepsOf<R>>): TestClient<R>
export function testClient<const RS extends readonly AnyRouter[]>(
  routers: RS,
  options?: TestClientOptions<DepsOf<RS[number]>>,
): TestClient<RS[number]>
export function testClient(
  target: Fetchable | AnyRouter | readonly AnyRouter[],
  options: TestClientOptions<Record<string, unknown>> = {},
): unknown {
  const harness = harnessFor(target, options)
  const client = brewer(harness, brewOptionsFrom(options.init))

  return controls(client as object, harness)
}

function harnessFor(
  target: Fetchable | AnyRouter | readonly AnyRouter[],
  options: TestClientOptions<Record<string, unknown>>,
): Harness {
  const init = {
    inject: options.inject as Record<string, unknown> | undefined,
    bind: options.bind,
    container: options.container,
    configure: options.configure,
  }

  if (Array.isArray(target)) {
    if (target.length === 0) {
      throw new ErrTestClientTarget('no routers were given')
    }

    return Harness.own(target as readonly AnyRouter[], init)
  }

  if (target instanceof Router) {
    return Harness.own([target], init)
  }

  if (typeof (target as Fetchable).fetch !== 'function') {
    throw new ErrTestClientTarget('the target is neither an application nor a router')
  }

  return Harness.borrow(target as TestApplication, init)
}

/**
 * Turns the per-client `RequestInit` into what `brewer` takes.
 *
 * `method` and `body` are dropped because the route and the call set them; `fetch` is never forwarded, because
 * the transport is the application and replacing it would skip the readying the client does on the way through.
 */
function brewOptionsFrom(init: RequestInit | undefined): BrewOptions {
  if (init === undefined) {
    return {}
  }

  const { method: _method, body: _body, headers, ...rest } = init

  return headers === undefined ? rest : { ...rest, headers: new Headers(headers) }
}

/**
 * Wraps the brewer client so the `$` controls answer before a segment lookup does.
 *
 * A function target, and `apply` forwarded, because the root node is callable when a route binds a parameter in
 * its first segment.
 */
function controls(client: object, harness: Harness): unknown {
  const own: Record<string | symbol, unknown> = {
    $app: harness.app,
    $container: harness.app.container,
    $fetch: (input: Request | string | URL, init?: RequestInit) => harness.fetch(input, init),
    $ready: () => harness.ready(),
    $close: () => harness.close(),
    [Symbol.asyncDispose]: () => harness.close(),
  }

  return new Proxy(target as object, {
    get: (_target, prop) => (prop in own ? own[prop] : Reflect.get(client, prop)),
    apply: (_target, thisArg, args: unknown[]) => Reflect.apply(client as () => unknown, thisArg, args),
  })
}

/**
 * The proxy's target, and never called.
 *
 * A function rather than an object so the client stays callable, which it has to be for a route binding a
 * parameter in its first segment. Every operation is trapped; nothing reaches this.
 */
function target(): void {
  return undefined
}
