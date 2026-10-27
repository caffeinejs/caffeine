import { $t, type InferSchema } from '@caffeinejs/application/schema'

const Strings = $t.Array($t.String())

/** One route, as `RouteInventory` from `@caffeinejs/http` records it. */
export const RouteSchema = $t.Object({
  methods: Strings,
  url: $t.String(),
  kind: $t.UnionEnum(['compiled', 'raw']),
  handler: $t.Optional($t.String()),
  group: $t.Optional($t.String()),
  produces: $t.Optional($t.String()),
  consumes: Strings,
  status: $t.Optional($t.Integer()),
  /** A duration, in milliseconds. */
  timeout: $t.Optional($t.Number()),
  /** A size, in bytes. */
  bodyLimit: $t.Optional($t.Number()),
  schema: $t.Object({
    params: $t.Boolean(),
    querystring: $t.Boolean(),
    headers: $t.Boolean(),
    body: $t.Boolean(),
    response: $t.Boolean(),
  }),
  security: $t.Object({
    authentication: $t.Object({
      skipped: $t.Boolean(),
      schemes: Strings,
      allowAnonymous: $t.Boolean(),
      gate: $t.Optional($t.String()),
    }),
    authorization: $t.Object({
      protected: $t.Boolean(),
      fallback: $t.Boolean(),
      policies: Strings,
      roleGroups: $t.Array(Strings),
      defaultPolicy: $t.Boolean(),
    }),
    guards: Strings,
    csrf: $t.UnionEnum(['protected', 'exempt', 'excluded', 'safe', 'uncovered']),
  }),
})

/** A server's routes. */
export const ServerRoutesSchema = $t.Object({
  /** The listener's name; `''` for the application's own server. */
  server: $t.String(),
  /** The server's `.basePath(...)`, `''` when it set none. */
  basePath: $t.String(),
  routes: $t.Array(RouteSchema),
})

/** What protects the application's routes as a whole. */
export const SecuritySchema = $t.Object({
  authentication: $t.Object({
    /** The registered schemes; empty when authentication is not installed. */
    schemes: Strings,
    defaultScheme: $t.Optional($t.String()),
  }),
  authorization: $t.Object({
    /** The policy a route that declares nothing answers to; absent when such a route is open. */
    fallbackPolicy: $t.Optional($t.String()),
    /** The path prefixes of raw routes the fallback policy leaves open. */
    fallbackExcept: Strings,
    /** The policy a bare `@Authorize()` asks for. */
    defaultPolicy: $t.Optional($t.String()),
  }),
  /** The authentication gates each server runs, by label: a server with none authenticates nobody. */
  gates: $t.Array($t.Object({ server: $t.String(), gates: Strings })),
})

export type ServerRoutesRecord = InferSchema<typeof ServerRoutesSchema>
export type SecurityRecord = InferSchema<typeof SecuritySchema>
