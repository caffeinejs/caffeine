import type { BindingGraph } from '@caffeinejs/di'
import type { BindingSnapshot, DevtoolsEvent, RouteSnapshot } from './types.js'

const EVENT_RING_SIZE = 500

export class DevtoolsStore {
  bindings: BindingSnapshot[] = []
  graph: BindingGraph = { nodes: [], edges: [] }
  routes: RouteSnapshot[] = []

  private readonly _events: DevtoolsEvent[] = []

  get events(): DevtoolsEvent[] {
    return this._events
  }

  addBinding(snapshot: BindingSnapshot): void {
    const idx = this.bindings.findIndex(b => b.id === snapshot.id)
    if (idx >= 0) {
      this.bindings[idx] = snapshot
    } else {
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
    this.graph = graph
  }
}
