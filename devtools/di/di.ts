import { $t, type InferSchema } from '@caffeinejs/application/schema'
import type { Binding, Container, InjectionToken } from '@caffeinejs/di'
import { buildBindingGraph, graphToMermaid, type GraphEdge } from '@caffeinejs/di/graph'
import { blend, ErrHTTPNotFound, Router } from '@caffeinejs/http'

import { ErrorSchema, type ToolInfo } from '../tool.js'

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
const InternalQuerySchema = $t.Object({ internal: $t.Optional($t.UnionEnum(['true', 'false'])) })

export const diTool: ToolInfo = {
  id: 'di',
  title: 'Dependency injection',
  description: 'The bindings of the container and how each is wired to the others',
}

/**
 * The container's bindings, as a table and as a dependency graph.
 *
 * - `GET /di/bindings`: every binding; `?internal=true` adds the framework's own
 * - `GET /di/bindings/:id`: one binding
 * - `GET /di/graph`: the dependency graph with its Mermaid source; `?internal=true` as above
 */
export function diRouter(container: Container) {
  const di = new Router('/di')

  const bindings = di
    .get('/bindings')
    .schema({ querystring: InternalQuerySchema, response: { 200: $t.Array(BindingSchema) } })
    .handler(ctx => bindingsOf(container, ctx.req.query().internal === 'true'))

  const binding = di
    .get('/bindings/:id')
    .schema({ response: { 200: BindingSchema, 404: ErrorSchema } })
    .handler(ctx => {
      const id = ctx.req.param().id
      const found = bindingsOf(container, true).find(binding => String(binding.id) === id)

      if (found === undefined) {
        throw new ErrHTTPNotFound(`No binding with id "${id}"`)
      }

      return found
    })

  const bindingGraph = di
    .get('/graph')
    .schema({ querystring: InternalQuerySchema, response: { 200: DependencyGraphSchema } })
    .handler((ctx): DependencyGraph => {
      const graph = buildBindingGraph(entriesOf(container, ctx.req.query().internal === 'true'))

      return { ...graph, mermaid: graphToMermaid(graph) }
    })

  return blend(bindings, binding, bindingGraph)
}

function bindingsOf(container: Container, internal: boolean): BindingRecord[] {
  const entries = entriesOf(container, internal)
  const graph = buildBindingGraph(entries)
  const bindings = new Map(entries.map(([, binding]) => [binding.id, binding]))
  const injections = graph.edges.filter(isInjection)

  return graph.nodes.map(node => {
    const binding = bindings.get(node.id)!

    return {
      id: node.id,
      key: node.label,
      scope: node.scopeID,
      names: node.names,
      labels: node.labels,
      profiles: [...binding.profiles],
      primary: node.primary,
      lazy: node.lazy,
      async: binding.async === true,
      internal: binding.internal === true,
      dependencies: unique(injections.filter(edge => edge.fromID === node.id).map(edge => edge.toID)),
      dependents: unique(injections.filter(edge => edge.toID === node.id).map(edge => edge.fromID)),
    }
  })
}

function entriesOf(container: Container, internal: boolean): Array<[InjectionToken, Binding]> {
  return Array.from(container.entries()).filter(([, binding]) => internal || binding.internal !== true)
}

function isInjection(edge: GraphEdge): boolean {
  return edge.kind === 'injection' || edge.kind === 'property-injection'
}

function unique(ids: number[]): number[] {
  return [...new Set(ids)]
}
