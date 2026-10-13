import type { ConfigTrigger } from '@caffeinejs/std/config'
import type { HealthStatus, LivenessState, ReadinessState } from '@caffeinejs/std/health'

/** `GET <path>`: the slices this server serves. */
export interface DevToolsIndex {
  slices: DevToolsIndexEntry[]
}

export interface DevToolsIndexEntry {
  id: string
  /** Where the slice answers on this server. */
  href: string
}

/** `GET <path>/bindings`: every binding the container holds. */
export interface DevToolsBindingsReport {
  bindings: DevToolsBinding[]
}

export interface DevToolsBinding {
  /** The id the graph's nodes carry, so a binding and its node join on it. */
  id: number
  key: string
  scope: string
  names: string[]
  labels: string[]
  primary: boolean
  lazy: boolean
  async: boolean
  /** Bound by the framework or a feature on the application's behalf. */
  internal: boolean
  /** The profiles the binding is limited to; empty when it is not limited. */
  profiles: string[]
  /** The class the binding builds, when it builds one. */
  type?: string
  /** The configuration class a `@Provides` binding came from. */
  configuredBy?: string
}

/** `GET <path>/routes`: what the application's controllers and routers declared, on every server. */
export interface DevToolsRoutesReport {
  groups: DevToolsRouteGroup[]
}

export interface DevToolsRouteGroup {
  /** The controller's class name, or the name the group was given. */
  name: string
  /** The ops server the group is bound to; absent for the application's own server. */
  server?: string
  routes: DevToolsRoute[]
}

export interface DevToolsRoute {
  /** The handler: a controller's method, or the name the route was given. Empty when it has neither. */
  name: string
  methods: string[]
  /** The path the server matches, without the application's base path. */
  path: string
  status?: number
  produces?: string
  consumes: string[]
  /** How many guards run before the handler. */
  guards: number
  authorization: DevToolsRouteAuthorization
}

/** What the route and every group above it declared. */
export interface DevToolsRouteAuthorization {
  /** Whether a request must pass authorization: something was declared, and not only a public route. */
  hasProtection: boolean
  allowAnonymous: boolean
  /** A bare declaration asked for the application's default policy. */
  defaultPolicy: boolean
  policies: string[]
  /** One entry per declaration: any role of an entry satisfies it, and every entry has to be satisfied. */
  roles: string[][]
  /** The schemes that authenticate the route: the ones it named, or the application's default. */
  schemes: string[]
}

/** `GET <path>/health`: the application's availability and its three probes. */
export interface DevToolsHealthReport {
  availability: DevToolsAvailability
  liveness: DevToolsProbe
  readiness: DevToolsProbe
  startup: DevToolsProbe
}

export interface DevToolsAvailability {
  live: LivenessState
  ready: ReadinessState
  started: boolean
  draining: boolean
  livenessReason?: string
  readinessReason?: string
}

export interface DevToolsProbe {
  ok: boolean
  /** The probe's own state, evaluated before any indicator runs. */
  checks: DevToolsProbeCheck[]
  indicators: DevToolsIndicator[]
}

export interface DevToolsProbeCheck {
  name: string
  ok: boolean
  detail?: string
}

/** One indicator's outcome. An indicator's `data` is for in-process callers and is never sent. */
export interface DevToolsIndicator {
  name: string
  status: HealthStatus
  critical: boolean
  detail?: string
  durationMs: number
}

/** `GET <path>/info`: who the application is and the process it runs in. */
export interface DevToolsInfoReport {
  /** From `caffeine.name`; empty when no source sets it. */
  name: string
  profiles: string[]
  /** The Node.js version, as `process.version` reports it. */
  node: string
  platform: string
  pid: number
  /** Seconds since the process started. */
  uptime: number
  /** In bytes. */
  memory: DevToolsMemory
}

export interface DevToolsMemory {
  rss: number
  heapTotal: number
  heapUsed: number
  external: number
  arrayBuffers: number
}

/** `GET <path>/configuration`: where the configuration came from, and which source set each value. */
export interface DevToolsConfigurationReport {
  revision: number
  profiles: string[]
  sources: DevToolsConfigSource[]
  /** Whether entries carry their values, which only `showValues()` turns on. */
  showsValues: boolean
  entries: DevToolsConfigEntry[]
}

export interface DevToolsConfigSource {
  name: string
  trigger: ConfigTrigger
  layers: string[]
  /** How many keys the source supplied. */
  keys: number
  /** In milliseconds since the epoch; `0` before a load has succeeded. */
  lastLoadedAt: number
  lastLoadMs: number
  consecutiveFailures: number
  /** The message of the last failure. */
  lastError?: string
}

export interface DevToolsConfigEntry {
  /** Dotted. An array is one entry, at its own path. */
  path: string
  /** The layer that set the value; absent when it is the schema's default. */
  layer?: string
  /** Where in that layer the value came from: a file, an environment variable. */
  origin?: string
  /** Present only when values are shown and the path is not masked. */
  value?: unknown
  /** Values are shown, and this one is withheld. */
  masked?: true
}
