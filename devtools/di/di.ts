import { DevTool, ErrDevToolNotFound, type DevToolOperation } from '@caffeinejs/application/devtools'
import type { Binding, Container, InjectionToken } from '@caffeinejs/di'
import { buildBindingGraph, graphToMermaid, type BindingGraph, type GraphEdge } from '@caffeinejs/di/graph'

/** One binding of the container, and how it is wired to the others. */
export interface BindingRecord {
  readonly id: number
  readonly key: string
  readonly scope: string
  readonly names: readonly string[]
  readonly labels: readonly string[]
  readonly profiles: readonly string[]
  readonly primary: boolean
  readonly lazy: boolean
  readonly async: boolean
  /** Bound by the framework for its own use. Left out of a listing unless asked for. */
  readonly internal: boolean
  /** The ids of the bindings this one is injected with. */
  readonly dependencies: readonly number[]
  /** The ids of the bindings injected with this one. */
  readonly dependents: readonly number[]
}

/** The dependency graph, and the same graph as a Mermaid flowchart. */
export interface DependencyGraph extends BindingGraph {
  readonly mermaid: string
}

/**
 * The container's bindings, as a table and as a dependency graph.
 *
 * - `GET /di/bindings`: every binding; `?internal=true` adds the framework's own
 * - `GET /di/bindings/:id`: one binding
 * - `GET /di/graph`: the dependency graph with its Mermaid source; `?internal=true` as above
 */
export class DependencyInjectionTool extends DevTool {
  readonly id = 'di'
  readonly title = 'Dependency injection'
  readonly description = 'The bindings of the container and how each is wired to the others'
  readonly operations: readonly DevToolOperation[]

  readonly #container: Container

  constructor(container: Container) {
    super()
    this.#container = container
    this.operations = [
      { method: 'GET', path: '/bindings', handle: ({ query }) => this.#bindings(query.internal === 'true') },
      { method: 'GET', path: '/bindings/:id', handle: ({ params }) => this.#binding(params.id) },
      { method: 'GET', path: '/graph', handle: ({ query }) => this.#graph(query.internal === 'true') },
    ]
  }

  #bindings(internal: boolean): BindingRecord[] {
    const entries = this.#entries(internal)
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

  #binding(id: string): BindingRecord {
    const found = this.#bindings(true).find(binding => String(binding.id) === id)

    if (found === undefined) {
      throw new ErrDevToolNotFound(`No binding with id "${id}"`)
    }

    return found
  }

  #graph(internal: boolean): DependencyGraph {
    const graph = buildBindingGraph(this.#entries(internal))

    return { ...graph, mermaid: graphToMermaid(graph) }
  }

  #entries(internal: boolean): Array<[InjectionToken, Binding]> {
    return Array.from(this.#container.entries()).filter(([, binding]) => internal || binding.internal !== true)
  }
}

function isInjection(edge: GraphEdge): boolean {
  return edge.kind === 'injection' || edge.kind === 'property-injection'
}

function unique(ids: number[]): number[] {
  return [...new Set(ids)]
}
