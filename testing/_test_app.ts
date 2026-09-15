import {
  CaffeineIoC,
  type Container,
  type Injection,
  type InjectionDescriptor,
  type InjectionStage,
  type ObjectInjection,
  type ObjectInjections,
} from '@caffeinejs/di'
import { createWebApplication, type FastifyAdapter, type Router, type WebApplication } from '@caffeinejs/http'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { ErrTestClientAlreadyReady } from './error.js'

/** Any router, spelled the way `blend` and `mount` spell it. */
export type AnyRouter = Router<any, any, any, any, any>

/** The application a client drives, whichever way it got one. */
export type TestApplication = WebApplication<
  FastifyInstance,
  FastifyRequest,
  FastifyAdapter<FastifyInstance, FastifyRequest>
>

export interface HarnessInit {
  inject?: Record<string, unknown>
  bind?: (container: Container) => void
  container?: Container
  configure?: (app: TestApplication) => void
}

/**
 * The application behind one test client: readied on first use, closed once, and left no worse than found.
 *
 * Readying is deferred rather than done here so that `testClient` can stay synchronous and so that the
 * application is still configurable — `client.$app.use(...)` — up until the first request.
 */
export class Harness {
  readonly app: TestApplication
  readonly #overrides: Record<string, unknown>
  #restoreResolver: (() => void) | undefined
  #ready: Promise<void> | undefined
  #closed: Promise<void> | undefined

  private constructor(app: TestApplication, overrides: Record<string, unknown>) {
    this.app = app
    this.#overrides = overrides
  }

  /** Builds an application around routers the caller has not mounted anywhere. */
  static own(routers: readonly AnyRouter[], init: HarnessInit): Harness {
    // A container of our own, and a live one: handed a live container the application skips `autoWire()`, which is
    // what reads the process-wide registry every `@Controller` and `@Injectable` writes itself into at class
    // definition. Left to build its own, the application would route every controller the test file happened to
    // import. Passing `container` opts back in — `new CaffeineIoC()` wires the registry as an application does.
    const container = init.container ?? new CaffeineIoC({ decorators: false })
    const app: TestApplication = createWebApplication({ container })

    init.configure?.(app)

    // Mounted for effect, and the result dropped: `mount` re-types the application with the routes and
    // dependencies it just took on, which is exactly what a list of `Router<any, …>` cannot say anything useful
    // about. The client's own type argument carries that instead, and at run time `mount` returns this app.
    app.mount(...routers)

    const harness = new Harness(app, { ...init.inject })

    init.bind?.(app.container)
    harness.#interceptInjection()

    return harness
  }

  /** Drives an application the caller built. Its lifecycle still passes through the client. */
  static borrow(app: TestApplication, init: HarnessInit): Harness {
    const harness = new Harness(app, { ...init.inject })
    const started = isStarted(app)

    // The dependency bags are built while the application sets up, so a shim installed afterwards would be read
    // by nothing. Say so rather than accept the option and ignore it.
    if (started && Object.keys(harness.#overrides).length > 0) {
      throw new ErrTestClientAlreadyReady('inject')
    }

    if (started && init.bind !== undefined) {
      throw new ErrTestClientAlreadyReady('bind')
    }

    init.bind?.(app.container)
    harness.#interceptInjection()

    return harness
  }

  /** Readies the application, once, however many requests race for it. */
  ready(): Promise<void> {
    this.#ready ??= this.app.ready()
    return this.#ready
  }

  async fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
    await this.ready()
    return this.app.fetch(input, init)
  }

  /** Closes the application and puts the container back the way it was found. */
  close(): Promise<void> {
    this.#closed ??= this.#close()
    return this.#closed
  }

  async #close(): Promise<void> {
    try {
      // An application that was never readied has nothing to tear down, and closing it would run a drain and a
      // container dispose over a container that never initialized.
      if (this.#ready !== undefined) {
        await this.#ready.catch(() => undefined)
        await this.app.close()
      }
    } finally {
      this.#restoreResolver?.()
      this.#restoreResolver = undefined
    }
  }

  /**
   * Wraps the dependency bag a route's `inject()` compiles to, so a name can be answered with something else.
   *
   * The bag is what the handler is handed, and its fields are getters that resolve through the binding on each
   * access — so wrapping the bag leaves every name the test did not replace resolving exactly as it did, scope
   * included. Wrapping the *dependency* instead would put a proxy where `this` goes, and a class reading a private
   * field through it would throw.
   *
   * A replaced name is also marked optional on the way in, because compiling the bag resolves every key it names
   * and a name being replaced is one the test is entitled not to have bound at all. Optional makes the compile
   * succeed and the getter answer `undefined`, which the wrapper then never consults.
   *
   * Shadowed on the instance rather than the prototype: the container may be the caller's, and it is handed back
   * unchanged when the client closes.
   */
  #interceptInjection(): void {
    const container = this.app.container
    const overrides = this.#overrides

    if (Object.keys(overrides).length === 0) {
      return
    }

    const original = container.resolver.bind(container)

    container.resolver = function resolver<I extends Injection>(injection: I) {
      const build = original(relaxOverridden(injection, overrides) as I)

      return () => {
        const bag = build()

        if (bag === null || typeof bag !== 'object') {
          return bag
        }

        return new Proxy(bag as object, {
          get: (target, prop, receiver) =>
            typeof prop === 'string' && prop in overrides ? overrides[prop] : Reflect.get(target, prop, receiver),
        }) as ReturnType<typeof build>
      }
    } as Container['resolver']

    this.#restoreResolver = () => {
      delete (container as { resolver?: unknown }).resolver
    }
  }
}

/**
 * Whether the application has already been set up.
 *
 * `routeGroups` is the only public thing that answers it: it throws until `ready()` has run. There is no
 * `started` on the public type, and adding one to `@caffeinejs/http` for this would be a wider change than the
 * question deserves.
 */
function isStarted(app: TestApplication): boolean {
  try {
    void app.routeGroups
    return true
  } catch {
    return false
  }
}

/**
 * Marks every replaced name optional, leaving the rest of the injection exactly as it was.
 *
 * Only the object stage is touched, and only its direct children: a nested bag names its own properties and a
 * replacement is keyed by the name the handler reads, which is a property of the outermost one.
 */
function relaxOverridden(injection: Injection, overrides: Record<string, unknown>): Injection {
  if (injection === null || typeof injection !== 'object' || !('stages' in injection)) {
    return injection
  }

  const descriptor = injection as InjectionDescriptor
  const stages = descriptor.stages

  if (stages === undefined) {
    return injection
  }

  let touched = false

  const relaxed: InjectionStage[] = stages.map(stage => {
    const children = (stage.args as ObjectInjections | undefined)?.children

    if (children === undefined) {
      return stage
    }

    const next: Record<string | symbol, ObjectInjection> = { ...children }

    for (const name of Object.keys(overrides)) {
      const child = next[name]

      if (child !== undefined && 'children' in child === false) {
        next[name] = { ...(child as InjectionDescriptor), optional: true }
        touched = true
      }
    }

    return touched ? { ...stage, args: { ...(stage.args as ObjectInjections), children: next } } : stage
  })

  return touched ? { ...descriptor, stages: relaxed } : injection
}
