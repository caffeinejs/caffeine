import { ErrApplicationNotReady } from '@caffeinejs/application'
import type { ByteSize } from '@caffeinejs/std/bytes'
import type { Duration } from '@caffeinejs/std/duration'

/** Adds one server's routes. The adapter's, through `AdapterIn.recordRoutes`; nothing else writes the inventory. */
export const kRecordServer: unique symbol = Symbol('@caffeinejs/http:inventory.record')
/** Marks the inventory complete, once every server is built. */
export const kCompleteInventory: unique symbol = Symbol('@caffeinejs/http:inventory.complete')

/**
 * Every route of every server the application runs: the application's own and each listener's, the routes plugins
 * mounted and the ones registered straight on the server (health probes, static files) included.
 *
 * Plain data, built once every route has registered, and readable once the application has bootstrapped. What a
 * route requires is described as the server decided it, so a route a gate covers names that gate, and a route
 * cross-origin protection leaves alone says why.
 *
 * Resolve it from the container: `container.get(RouteInventory)`.
 */
export class RouteInventory {
  readonly #servers: ServerRoutes[] = []
  #complete = false

  /**
   * The application's own server first, then each listener in install order.
   *
   * @throws ErrApplicationNotReady before every server is built.
   */
  get servers(): readonly ServerRoutes[] {
    if (!this.#complete) {
      throw new ErrApplicationNotReady('read the route inventory')
    }

    return this.#servers
  }

  [kRecordServer](server: ServerRoutes): void {
    this.#servers.push(server)
  }

  [kCompleteInventory](): void {
    this.#complete = true
  }
}

/** One server's routes. */
export interface ServerRoutes {
  /** The listener's name; `undefined` for the application's own server. */
  readonly server: string | undefined
  /** The server's `.basePath(...)`, `''` when it set none. Every route's {@link RouteRecord.url} is under it. */
  readonly basePath: string
  readonly routes: readonly RouteRecord[]
}

/** One route, as its server registered it. */
export interface RouteRecord {
  /** A GET route's automatic HEAD twin is folded in: `['GET', 'HEAD']`. */
  readonly methods: readonly string[]
  /** The path the route registered under, without the server's base path. */
  readonly url: string
  /** `compiled` when Caffeine compiled the route; `raw` when a plugin registered it straight on the server. */
  readonly kind: 'compiled' | 'raw'
  /** The controller method or route name; a raw route's handler function name, when it has one. */
  readonly handler: string | undefined
  /** The group a compiled route was compiled in: a controller's class name or a router's name. */
  readonly group: string | undefined
  readonly produces: string | undefined
  readonly consumes: readonly string[]
  readonly status: number | undefined
  readonly timeout: Duration | undefined
  readonly bodyLimit: ByteSize | undefined
  /** Which parts of the request and response a schema describes. */
  readonly schema: RouteSchemaRecord
  readonly security: RouteSecurityRecord
}

export interface RouteSchemaRecord {
  readonly params: boolean
  readonly querystring: boolean
  readonly headers: boolean
  readonly body: boolean
  readonly response: boolean
}

export interface RouteSecurityRecord {
  readonly authentication: {
    /** Exempt from authentication: no principal is established (`authenticationExempt()`, a health probe). */
    readonly skipped: boolean
    /** The schemes that authenticate the route, the application's default when it named none. */
    readonly schemes: readonly string[]
    /** Declared public: authenticated when credentials come, never refused for lacking them. */
    readonly allowAnonymous: boolean
    /** The label of the gate that authenticates the route; `undefined` when no gate covers it. */
    readonly gate: string | undefined
  }
  readonly authorization: {
    /** A request is authorized before the handler runs, by what the route declared or by the fallback policy. */
    readonly protected: boolean
    /** Authorized by the application's fallback policy, the route having declared nothing. */
    readonly fallback: boolean
    readonly policies: readonly string[]
    readonly roleGroups: ReadonlyArray<readonly string[]>
    /** Asks for the policy the application set as the decorator's default. */
    readonly defaultPolicy: boolean
  }
  /** The guards the route runs, in order, by the name of the key each was bound under. */
  readonly guards: readonly string[]
  /**
   * What cross-origin protection does on the route:
   *
   * - `protected`: an unsafe request is checked
   * - `exempt`: the route is marked exempt
   * - `excluded`: its path is under an `exclude(...)` of every protection covering it
   * - `safe`: it answers safe methods alone, which are never checked
   * - `uncovered`: no `csrf()` covers it
   */
  readonly csrf: 'protected' | 'exempt' | 'excluded' | 'safe' | 'uncovered'
}
