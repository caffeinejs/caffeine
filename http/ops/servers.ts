import type { Container } from '@caffeinejs/di'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'

import type {
  Adapter,
  AdapterExtensions,
  AdapterServer,
  AdapterTypes,
  HTTPSetupContext,
  ServerConfigurer,
} from '../adapter.js'
import { boundTo, kBindTo } from '../binding.js'
import { ErrConfiguration } from '../error/common.js'
import { solutions } from '../error/util.js'
import type { MiddlewarePipeline } from '../middleware/pipeline.js'
import type { RouteGroupCompiler, RouteGroupMeta } from '../routing/compile.js'
import type { GatedRoute } from '../routing/fastify/route_config.js'
import { inheritGroupSpec } from '../routing/inherit.js'
import type { RouteGroup } from '../routing/route.js'
import type { Routing } from '../routing/routing.js'
import type { RouteGroupSpec } from '../routing/spec.js'
import { ErrAuthenticationRequired, ErrAuthSchemeNotFound } from '../security/auth/errors.js'
import { AuthenticationSchemeProvider } from '../security/auth/scheme_provider.js'
import { compileRoutePolicy, kAuthzEvaluators, kAuthzHandlers, kAuthzOpts } from '../security/authz/index.js'
import type { OpsServer } from './builder.js'
import { OpsDefinition } from './definition.js'

/** One installed ops server, from the routes selected for it to the server built from them. */
interface Entry<T extends AdapterTypes> {
  readonly definition: OpsDefinition
  /** What every group it serves is nested in: the server's authorization, and its name as their binding. */
  readonly outer: RouteGroupSpec<T['request']>
  groups: RouteGroup<T['request']>[]
  /**
   * What a route a plugin registers straight on the server answers to: the server's `authorize(...)`, compiled.
   * `undefined` when it declared nothing.
   */
  rawRoutes?: GatedRoute
  server?: AdapterServer<T>
}

/** What an ops server is built with that the application's own server provides. */
export interface OpsSetupInput<T extends AdapterTypes> {
  readonly context: HTTPSetupContext
  /** The application's own: their scoped half — what routers and controllers asked for — is every server's. */
  readonly extensions: AdapterExtensions<T['extension']>
  /** The framework's head slots, built fresh for one more server: error handling, then cookies. */
  headSlots(): T['extension'][]
  /** Folds `.server(...)` configurers the way the application folds its own, against the server's own context. */
  resolveServerOptions(
    configurers: readonly ServerConfigurer<T>[],
    context: HTTPSetupContext,
  ): Promise<T['serverOptions']>
  /** The compiler every group went through, for a group `$route` adds. */
  readonly compileRouteGroup: RouteGroupCompiler
}

/**
 * The ops servers an application installed: which routers each serves, the server built for each, and their
 * lifecycle after the application's own server.
 */
export class OpsServerSet<T extends AdapterTypes> {
  readonly #entries: Entry<T>[]
  #view: ReadonlyMap<string, OpsServer<T>> | undefined

  constructor(container: Container) {
    this.#entries = container.getManyOptional(OpsDefinition).map(definition => ({
      definition,
      outer: outerGroup(definition),
      groups: [],
    }))
  }

  /** The installed names, in install order. */
  get names(): string[] {
    return this.#entries.map(entry => entry.definition.name)
  }

  /** The servers, once {@link setup} has built them. */
  get view(): ReadonlyMap<string, OpsServer<T>> | undefined {
    return this.#view
  }

  /**
   * Compiles the routers bound to each server, nested in the server's outermost group. Returns every group compiled,
   * for the application's route table.
   */
  select(routing: Routing<T['request']>): RouteGroup<T['request']>[] {
    const compiled: RouteGroup<T['request']>[] = []

    for (const entry of this.#entries) {
      const name = entry.definition.name
      entry.groups = routing.select(labels => boundTo(labels) === name, entry.outer)
      compiled.push(...entry.groups)
    }

    return compiled
  }

  /**
   * Compiles each server's `authorize(...)` for the routes a plugin registers straight on it, refusing at start-up
   * what could never be enforced — even when no route of the server compiles it: a raw route, such as a health
   * probe, compiles nothing.
   *
   * @throws ErrAuthenticationRequired for a server declaring protection with `Authentication(...)` never installed.
   * @throws ErrAuthSchemeNotFound for a scheme `Authentication(...)` never registered.
   * @throws ErrAuthzPolicyNotFound for a policy `Authorization(...)` never registered.
   */
  compileAuthorization(container: Container): void {
    const schemeProvider = container.getOptional(AuthenticationSchemeProvider)
    const authzOpts = container.getOptional(kAuthzOpts)

    for (const entry of this.#entries) {
      const authz = entry.definition.authz
      if (authz === undefined) {
        continue
      }

      // Nothing could authenticate a caller, so a server declaring protection would answer anyone.
      if (schemeProvider === undefined && !authz.allowAnonymous) {
        throw new ErrAuthenticationRequired()
      }

      for (const scheme of authz.schemes ?? []) {
        if (schemeProvider?.schemeFor(scheme) === undefined) {
          throw new ErrAuthSchemeNotFound(scheme, schemeProvider?.schemeNames)
        }
      }

      entry.rawRoutes = {
        schemes: authz.schemes,
        allowAnonymous: authz.allowAnonymous,
        authorizer:
          authzOpts === undefined
            ? undefined
            : compileRoutePolicy(authzOpts, container.get(kAuthzEvaluators), container.get(kAuthzHandlers), authz),
      }
    }
  }

  /**
   * Builds every ops server through `adapter`, one after another, in install order: each from its own settings,
   * plugins and middleware, everything handed the server's own context.
   */
  async setup(adapter: Adapter<T>, input: OpsSetupInput<T>): Promise<void> {
    for (const entry of this.#entries) {
      const { definition } = entry
      const context: HTTPSetupContext = {
        ...input.context,
        logger: input.context.logger.child({ ops: definition.name }),
      }

      // The server's own settings first, as for the application's own: a callback that fails should do so before
      // a factory with side effects has run.
      const server = await input.resolveServerOptions(definition.server as readonly ServerConfigurer<T>[], context)
      const root = input.headSlots()

      // Ahead of its own plugins, so every route one registers straight on the server meets the server's
      // `authorize(...)` as its routers' routes do.
      if (entry.rawRoutes !== undefined) {
        root.push(authorizeRawRoutes(entry.rawRoutes) as T['extension'])
      }

      // Its own `.with(...)` factories, in the order they were written, after the framework's slots.
      for (const factory of definition.plugins) {
        root.push((await factory(context)) as T['extension'])
      }

      entry.server = await adapter.setup({
        routeGroups: entry.groups,
        compileRouteGroup: opsCompiler(input.compileRouteGroup, entry),
        context,
        middlewares: definition.middlewares as MiddlewarePipeline<T['hook']>,
        extensions: input.extensions.withRoot(root),
        server,
        customize: undefined,
        basePath: undefined,
      })
    }

    this.#view = new Map(
      this.#entries.map(entry => [entry.definition.name, opsServer(entry.definition.name, entry.server!)]),
    )
  }

  /** Listens on every server, one after another, each on the listener it was built with. */
  async run(): Promise<void> {
    for (const entry of this.#entries) {
      await entry.server?.run(...([] as unknown as T['runArgs']))
    }
  }

  /** Closes every server built, the rest even when one fails. Resolves to what failed. */
  async teardown(): Promise<unknown[]> {
    const failures: unknown[] = []

    for (const entry of this.#entries) {
      try {
        await entry.server?.teardown()
      } catch (err) {
        failures.push(err)
      }
    }

    return failures
  }

  async forceTeardown(): Promise<void> {
    for (const entry of this.#entries) {
      await entry.server?.forceTeardown?.()
    }
  }
}

/** What every group an ops server serves is nested in: its authorization, outermost, and its binding. */
function outerGroup<R>(definition: OpsDefinition): RouteGroupSpec<R> {
  return {
    path: '',
    routes: [],
    accept: [],
    contentType: '',
    authz: definition.authz,
    labels: new Map([[kBindTo, definition.name]]),
  }
}

/**
 * What `$route` compiles a group with on an ops server: nested in the server's outermost group like every group it
 * serves, and refused when bound to another server, which would never see it.
 */
function opsCompiler<T extends AdapterTypes>(compile: RouteGroupCompiler, entry: Entry<T>): RouteGroupCompiler {
  const name = entry.definition.name

  return <R>(spec: RouteGroupSpec<R>, meta: RouteGroupMeta<R>): RouteGroup<R> => {
    const bound = boundTo(spec.labels)

    if (bound !== undefined && bound !== name) {
      throw new ErrConfiguration(
        `Cannot add route group "${meta.name}" to ops server "${name}": it is bound to "${bound}"` +
          solutions('Drop the binding: "$route" adds the group to the server its plugin runs on'),
      )
    }

    return compile(inheritGroupSpec(entry.outer as RouteGroupSpec<R>, spec), meta)
  }
}

/**
 * Holds every route a plugin registers straight on an ops server to the server's `authorize(...)`, the way its
 * routers' routes are held: a route exempt from authentication, a health probe's, stays exempt, and one that
 * declared its own keeps it.
 */
function authorizeRawRoutes(auth: GatedRoute) {
  return fp(
    async (instance: FastifyInstance) => {
      // After the adapter's own `onRoute` hook, which gives every route its `$caffeine`.
      instance.addHook('onRoute', route => {
        const meta = route.config?.$caffeine

        if (meta !== undefined && meta.compiled === undefined && !meta.skipAuthentication) {
          meta.auth ??= auth
        }
      })
    },
    { name: 'caffeine-ops-authorization' },
  )
}

function opsServer<T extends AdapterTypes>(name: string, server: AdapterServer<T>): OpsServer<T> {
  return {
    name,
    get instance() {
      return server.instance
    },
    get address() {
      return server.address
    },
    fetch: (request, options) => server.fetch(request, options),
  }
}

/** The solutions for a binding no installed server answers to. */
export function unknownServer(name: string, installed: readonly string[]): string[] {
  const solutions = [`Install it: ".install(Ops('${name}', ...))"`]

  if (installed.length > 0) {
    const names = installed.map(candidate => `"${candidate}"`).join(', ')
    solutions.push(`Or bind to an installed server: ${names}`)
  }

  return solutions
}
