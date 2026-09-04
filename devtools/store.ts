import type { BindingGraph } from '@caffeinejs/di'

import type { BindingSnapshot, DevtoolsEvent, RouteSnapshot } from './types.js'

const EVENT_RING_SIZE = 500

const EMPTY_GRAPH: BindingGraph = { nodes: [], edges: [] }

export class DevtoolsStore {
  bindings: BindingSnapshot[] = []
  routes: RouteSnapshot[] = []

  private readonly _events: DevtoolsEvent[] = []
  private readonly _bindingIndex = new Map<number, number>()

  private _graph: BindingGraph = EMPTY_GRAPH
  private _graphSource?: () => BindingGraph
  private _graphStale = false

  get events(): DevtoolsEvent[] {
    return this._events
  }

  /**
   * The binding graph, rebuilt on read when the container has registered anything since the last read.
   *
   * Building it per registration instead would be quadratic over a boot: every registration walks every
   * binding, and a container registers as many bindings as it holds.
   */
  get graph(): BindingGraph {
    if (this._graphStale && this._graphSource !== undefined) {
      this._graph = this._graphSource()
      this._graphStale = false
    }

    return this._graph
  }

  addBinding(snapshot: BindingSnapshot): void {
    const idx = this._bindingIndex.get(snapshot.id)
    if (idx !== undefined) {
      this.bindings[idx] = snapshot
    } else {
      this._bindingIndex.set(snapshot.id, this.bindings.length)
      this.bindings.push(snapshot)
    }
  }

  pushEvent(event: DevtoolsEvent): void {
    if (this._events.length >= EVENT_RING_SIZE) {
      this._events.shift()
    }
    this._events.push(event)
  }

  setRoutes(routes: RouteSnapshot[]): void {
    this.routes = routes
  }

  setGraph(graph: BindingGraph): void {
    this._graph = graph
    this._graphStale = false
  }

  /** Registers how to rebuild the graph, and marks the current one stale. */
  invalidateGraph(source: () => BindingGraph): void {
    this._graphSource = source
    this._graphStale = true
  }
}
