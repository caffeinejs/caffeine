import type { Binding, Container, InjectionToken } from '@caffeinejs/di'
import { buildBindingGraph, graphToMermaid, type GraphEdge } from '@caffeinejs/di/graph'
import { ErrHTTPNotFound } from '@caffeinejs/http'

import type { ToolInfo } from '../tool.js'
import type { BindingRecord, DependencyGraph } from './di.schema.js'

export const diTool: ToolInfo = {
  id: 'di',
  title: 'Dependency injection',
  description: 'The bindings of the container and how each is wired to the others',
}

/** Reads the container's bindings as the devtools show them. */
export class DITool {
  readonly #container: Container

  constructor(container: Container) {
    this.#container = container
  }

  bindings(internal: boolean): BindingRecord[] {
    return bindingsOf(this.#container, internal)
  }

  /** @throws ErrHTTPNotFound when no binding has the id `id`. */
  binding(id: string): BindingRecord {
    const found = bindingsOf(this.#container, true).find(binding => String(binding.id) === id)

    if (found === undefined) {
      throw new ErrHTTPNotFound(`No binding with id "${id}"`)
    }

    return found
  }

  graph(internal: boolean): DependencyGraph {
    const graph = buildBindingGraph(entriesOf(this.#container, internal))

    return { ...graph, mermaid: graphToMermaid(graph) }
  }
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
