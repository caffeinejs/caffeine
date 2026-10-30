import { $t, type InferSchema } from '@caffeinejs/application/schema'

/** One binding of the container, and how it is wired to the others. */
export const BindingSchema = $t.Object({
  id: $t.Integer(),
  key: $t.String(),
  scope: $t.String(),
  names: $t.Array($t.String()),
  labels: $t.Array($t.String()),
  profiles: $t.Array($t.String()),
  primary: $t.Boolean(),
  lazy: $t.Boolean(),
  async: $t.Boolean(),
  /** Bound by the framework for its own use. Left out of a listing unless asked for. */
  internal: $t.Boolean(),
  /** The ids of the bindings this one is injected with. */
  dependencies: $t.Array($t.Integer()),
  /** The ids of the bindings injected with this one. */
  dependents: $t.Array($t.Integer()),
})

/** The dependency graph, as `buildBindingGraph` from `@caffeinejs/di/graph` builds it, and as a Mermaid flowchart. */
export const DependencyGraphSchema = $t.Object({
  nodes: $t.Array(
    $t.Object({
      id: $t.Integer(),
      label: $t.String(),
      scopeID: $t.String(),
      names: $t.Array($t.String()),
      labels: $t.Array($t.String()),
      primary: $t.Boolean(),
      lazy: $t.Boolean(),
    }),
  ),
  edges: $t.Array(
    $t.Object({
      fromID: $t.Integer(),
      toID: $t.Integer(),
      kind: $t.UnionEnum(['injection', 'property-injection', 'named-group', 'label-group']),
      meta: $t.Optional($t.String()),
      key: $t.Optional($t.String()),
    }),
  ),
  mermaid: $t.String(),
})

export type BindingRecord = InferSchema<typeof BindingSchema>
export type DependencyGraph = InferSchema<typeof DependencyGraphSchema>

/** `?internal=true` adds the framework's own bindings. */
export const InternalQuerySchema = $t.Object({ internal: $t.Optional($t.UnionEnum(['true', 'false'])) })
