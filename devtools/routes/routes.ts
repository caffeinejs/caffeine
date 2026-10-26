import { DevTool, type DevToolOperation } from '@caffeinejs/application/devtools'
import type { Container } from '@caffeinejs/di'
import { AuthenticationSchemeProvider, kAuthzOpts, RouteInventory, type ServerRoutes } from '@caffeinejs/http'

/** A server's routes, the server named as the devtools name it. */
export interface ServerRoutesRecord extends Omit<ServerRoutes, 'server'> {
  /** The listener's name; `''` for the application's own server. */
  readonly server: string
}

/** What protects the application's routes as a whole. */
export interface SecurityRecord {
  readonly authentication: {
    /** The registered schemes; empty when authentication is not installed. */
    readonly schemes: readonly string[]
    readonly defaultScheme: string | undefined
  }
  readonly authorization: {
    /** The policy a route that declares nothing answers to; `undefined` when such a route is open. */
    readonly fallbackPolicy: string | undefined
    /** The path prefixes of raw routes the fallback policy leaves open. */
    readonly fallbackExcept: readonly string[]
    /** The policy a bare `@Authorize()` asks for. */
    readonly defaultPolicy: string | undefined
  }
  /** The authentication gates each server runs, by label: a server with none authenticates nobody. */
  readonly gates: ReadonlyArray<{ readonly server: string; readonly gates: readonly string[] }>
}

/**
 * Every route of every server, the routes plugins registered included, and what each one requires: its schemes,
 * the gate that authenticates it, its roles and policies, its guards and its cross-origin protection.
 *
 * - `GET /routes`: every server's routes; `?server=<name>` one server's, `?server=` the application's own
 * - `GET /routes/security`: the schemes, the fallback policy and the gates
 */
export class RoutesTool extends DevTool {
  readonly id = 'routes'
  readonly title = 'Routes'
  readonly description = 'Every route of every server, and what each one requires'
  readonly operations: readonly DevToolOperation[]

  readonly #container: Container

  constructor(container: Container) {
    super()
    this.#container = container
    this.operations = [
      { method: 'GET', path: '', handle: ({ query }) => this.#routes(query.server) },
      { method: 'GET', path: '/security', handle: () => this.#security() },
    ]
  }

  #routes(server: string | undefined): ServerRoutesRecord[] {
    const all = this.#servers()

    return server === undefined ? all : all.filter(entry => entry.server === server)
  }

  #security(): SecurityRecord {
    const schemes = this.#container.getOptional(AuthenticationSchemeProvider)
    const authz = this.#container.getOptional(kAuthzOpts)

    return {
      authentication: {
        schemes: [...(schemes?.schemeNames ?? [])],
        defaultScheme: schemes === undefined ? undefined : schemes.defaultAuthenticateScheme || undefined,
      },
      authorization: {
        fallbackPolicy: authz?.fallbackPolicy?.name,
        fallbackExcept: [...(authz?.fallbackExcept ?? [])],
        defaultPolicy: authz?.authorizeDecoratorDefaultPolicy.name,
      },
      gates: this.#servers().map(entry => ({
        server: entry.server,
        gates: [...new Set(entry.routes.flatMap(route => route.security.authentication.gate ?? []))],
      })),
    }
  }

  #servers(): ServerRoutesRecord[] {
    return this.#container.get(RouteInventory).servers.map(entry => ({ ...entry, server: entry.server ?? '' }))
  }
}
