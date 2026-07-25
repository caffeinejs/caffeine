export interface GraphNode {
  id: number
  label: string
  scopeID: string
  names: string[]
  labels: string[]
  primary: boolean
  lazy: boolean
}

export interface GraphEdge {
  fromID: number
  toID: number
  kind: string
  meta?: string
}

export interface BindingGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface BindingSnapshot {
  id: number
  key: string
  scopeID: string
  names: string[]
  labels: string[]
  primary: boolean
  lazy: boolean
  async: boolean
  internal: boolean
}

export interface RouteSnapshot {
  method: string[]
  path: string
  controllerKey: string
  controllerScope: string
  handler: string
  accept: string[]
  contentTypes: string[]
  responseStatus?: number
}

export interface DevtoolsEvent {
  kind: string
  ts: number
  payload: Record<string, unknown>
}

export type WsMessage
  = | {
    type: 'snapshot'
    bindings: BindingSnapshot[]
    graph: BindingGraph
    routes: RouteSnapshot[]
    events: DevtoolsEvent[]
  }
  | {
    type: 'event'
    event: DevtoolsEvent
  }
