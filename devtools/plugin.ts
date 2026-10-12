import {
  AuthenticationService,
  Router,
  type AdapterExtensionFactory,
  type HTTPPluginConfigurer,
  type RouteAuthzOptions,
  type SetupApplication,
} from '@caffeinejs/http'
import { errMessage } from '@caffeinejs/std/framework/err'

import { ErrDevToolsConfiguration } from './errors.js'
import type { DevToolsConfig } from './options.js'
import type { DevToolsSlice } from './slice.js'
import { bindings } from './slices/bindings.js'
import { configuration } from './slices/configuration.js'
import { graph } from './slices/graph.js'
import { health } from './slices/health.js'
import { info } from './slices/info.js'
import { routes } from './slices/routes.js'
import type { DevToolsIndex } from './wire.js'

const kBuild = Symbol('caffeine.devtools.build')

const DEFAULT_PATH = '/devtools'
const SLICE_ID = /^[a-z0-9][a-z0-9-]*$/

interface DevToolsOptions<C> {
  /** The path the index answers on, without a trailing slash: empty at the server's root. */
  base: string
  authorizations: readonly RouteAuthzOptions[]
  isPublic: boolean
  slices: readonly DevToolsSlice<C>[]
}

/**
 * Fluently builds what `devTools()` serves: where, which slices, and who may read them.
 *
 * What a fluent method sets is final. To let the environment move the endpoints, declare a block of
 * {@link DevToolsConfig} in the application's schema and hand its node to {@link config}.
 */
export class DevToolsBuilder<C = unknown> {
  #config: Partial<DevToolsConfig> | undefined
  #path: string | undefined
  readonly #authorizations: RouteAuthzOptions[] = []
  #public = false
  #slices: DevToolsSlice<C>[] | undefined

  /** Reads the settings from a node of the configuration tree. A fluent method called alongside it wins. */
  config(config: Partial<DevToolsConfig>): this {
    this.#config = config
    return this
  }

  /** Where the index answers, each slice under it. Defaults to `/devtools`; `/` serves the index at the root. */
  path(path: string): this {
    this.#path = path
    return this
  }

  /**
   * Requires what `options` declares on every DevTools route, the index included. Declarations add up, as a
   * router's do. Authenticating takes a gate on the same server: `Ops(name, o => o.with(authentication()))`.
   */
  authorize(options: RouteAuthzOptions): this {
    this.#authorizations.push(options)
    return this
  }

  /**
   * States that DevTools is served without authorization on purpose. It declares nothing, so the application's
   * fallback policy still applies; it silences the warning written when authentication is installed.
   */
  public(): this {
    this.#public = true
    return this
  }

  /** The slices to serve, in the order the index lists them. Calls add up; with none, every built-in is served. */
  slices(...slices: DevToolsSlice<C>[]): this {
    this.#slices ??= []
    this.#slices.push(...slices)
    return this
  }

  [kBuild](): DevToolsOptions<C> {
    const path = this.#path ?? this.#config?.path ?? DEFAULT_PATH

    if (!path.startsWith('/')) {
      throw new ErrDevToolsConfiguration(
        errMessage(`Cannot serve DevTools at "${path}": the path does not start with "/"`)
          .solutions(`Write it as "/${path}"`)
          .reference('@caffeinejs/devtools', ErrDevToolsConfiguration)
          .build(),
      )
    }

    if (this.#public && this.#authorizations.length > 0) {
      throw new ErrDevToolsConfiguration(
        errMessage('Cannot serve DevTools: both "authorize(...)" and "public()" were called')
          .solutions(
            'Remove "public()" to require what "authorize(...)" declares',
            'Remove "authorize(...)" to serve DevTools without authorization',
          )
          .reference('@caffeinejs/devtools', ErrDevToolsConfiguration)
          .build(),
      )
    }

    const slices = this.#slices ?? [bindings(), graph(), routes(), health(), info(), configuration()]
    const seen = new Set<string>()

    for (const { id } of slices) {
      if (!SLICE_ID.test(id)) {
        throw new ErrDevToolsConfiguration(
          errMessage(`Cannot serve DevTools slice "${id}": the id is not lower-case letters, digits and "-"`)
            .solutions('Give the slice an "id" of lower-case letters, digits and "-", starting with a letter or digit')
            .reference('@caffeinejs/devtools', ErrDevToolsConfiguration)
            .build(),
        )
      }

      if (seen.has(id)) {
        throw new ErrDevToolsConfiguration(
          errMessage(`Cannot serve DevTools slice "${id}" twice: two slices share the id`)
            .solutions('Pass each slice to ".slices(...)" once', 'Give one of the two slices another "id"')
            .reference('@caffeinejs/devtools', ErrDevToolsConfiguration)
            .build(),
        )
      }

      seen.add(id)
    }

    return {
      base: path.replace(/\/+$/, ''),
      authorizations: [...this.#authorizations],
      isPublic: this.#public,
      slices,
    }
  }
}

/**
 * Read-only JSON endpoints into the running application, one slice each: its bindings, dependency graph, routes,
 * health, process and configuration. Register it on an ops server, so it never shares a port with the
 * application's own API:
 *
 * ```ts
 * createWebApplication()
 *   .install(Authentication(a => a.addBasic('devtools', b => b.validate(checkOperator))))
 *   .install(
 *     Ops('devtools', o =>
 *       o
 *         .server(() => ({ listener: { port: 9100 } }))
 *         .with(authentication())
 *         .with(devTools(d => d.authorize({ schemes: ['devtools'] }))),
 *     ),
 *   )
 * ```
 *
 * `GET <path>` lists the slices served and where each answers. Every route declares what `authorize(...)` asked for,
 * answers with `cache-control: no-store`, and is marked internal, so a document describing the server's API leaves it
 * out. Without `authorize(...)` the routes declare nothing and answer to the application's fallback policy; with
 * authentication installed, that is warned about once unless `public()` says it is intended.
 *
 * It mounts one router on the server it is registered on, through `context.app`, and installs nothing else there.
 *
 * @throws ErrDevToolsConfiguration at start-up, for a path that does not start with "/", a slice id that is not
 *   lower-case letters, digits and "-", two slices sharing an id, or `public()` alongside `authorize(...)`.
 */
export function devTools<C = unknown>(
  configure?: HTTPPluginConfigurer<DevToolsBuilder<C>, C>,
): AdapterExtensionFactory<SetupApplication, C> {
  return context => {
    const builder = new DevToolsBuilder<C>()
    configure?.(builder, context)

    const { base, authorizations, isPublic, slices } = builder[kBuild]()

    // Configuring authentication binds the coordinator, and nothing else does, so its presence is the feature being on.
    if (authorizations.length === 0 && !isPublic && context.container.has(AuthenticationService)) {
      context.logger.warn(
        errMessage('DevTools is served without authorization while authentication is configured')
          .solutions(
            'Call ".authorize({ schemes: [...] })" on the DevTools builder to require authentication',
            'Call ".public()" on the DevTools builder to state that open access is intended',
          )
          .build(),
      )
    }

    const index: DevToolsIndex = { slices: slices.map(slice => ({ id: slice.id, href: `${base}/${slice.id}` })) }
    const root = shared(new Router(base).name('devtools'), authorizations).get('/', () => index)

    // Built here, at start-up: a slice resolves what it reads while building its router, so a misconfiguration
    // fails before anything listens. Nested in the root, each slice's routes inherit what the root declares.
    for (const slice of slices) {
      root.mount(`/${slice.id}`, slice.router(context).name(`devtools:${slice.id}`))
    }

    return context.app.mount(root)
  }
}

/** What every DevTools route shares, declared on the router every slice is nested in. It is the plugin's to set. */
function shared<R extends Router<any, any, any, any, any>>(router: R, authorizations: readonly RouteAuthzOptions[]): R {
  router.produces('application/json').header('cache-control', 'no-store').detail('http', { internal: true })

  // Only what was declared: routing reads any declaration, an empty one included, as protection.
  for (const authorization of authorizations) {
    router.authorize(authorization)
  }

  return router
}
