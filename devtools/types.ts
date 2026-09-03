import type { BindingGraph } from '@caffeinejs/di'

export type { BindingGraph }

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
  contentType: string
  responseStatus?: number
}

export type DevtoolsEventKind =
  | 'binding:registered'
  | 'binding:initialized'
  | 'binding:initialization-failed'
  | 'module:registered'
  | 'module:failed'
  | 'container:disposed'

export interface DevtoolsEvent {
  kind: DevtoolsEventKind
  ts: number
  payload: Record<string, unknown>
}

export type WsMessage =
  | {
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
