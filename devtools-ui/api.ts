import { brewer, type BrewClient } from '@caffeinejs/brewer'
import type { DevToolsRoutes } from '@caffeinejs/devtools'

import type { Config } from './app.config.js'
import { ErrDevToolsAnswered } from './shared/errors/index.js'

/** What a typed call answers: a member per status the route declares. */
interface Answer {
  readonly status: number
  readonly statusText: string
  json(): Promise<unknown>
}

/** The body of a call's `200`, typed from the route's schema. */
type OK<R> = R extends { readonly status: 200; json(): Promise<infer B> } ? B : never

/**
 * The devtools resources the UI reads. Each is a call of a client typed by the devtools' own routes,
 * `DevToolsRoutes`, so a resource the devtools rename or re-type fails to compile here rather than to render.
 *
 * @throws ErrDevToolsAnswered from every method when the devtools answer anything but `200`.
 */
export class DevToolsAPI {
  readonly #client: BrewClient<DevToolsRoutes>
  readonly #target: string
  readonly #headers: Record<string, string>

  constructor(config: Config) {
    const authorization = config.target.authorization
    this.#target = config.target.url
    this.#headers = authorization === undefined ? {} : { authorization }
    this.#client = brewer<DevToolsRoutes>(this.#target, { headers: this.#headers })
  }

  index() {
    return read(this.#client.get())
  }

  info() {
    return read(this.#client.info.get())
  }

  health() {
    return read(this.#client.health.get())
  }

  bindings(internal: 'true' | undefined) {
    return read(this.#client.di.bindings.get({ query: { internal } }))
  }

  graph(internal: 'true' | undefined) {
    return read(this.#client.di.graph.get({ query: { internal } }))
  }

  properties() {
    return read(this.#client.config.properties.get())
  }

  property(path: string) {
    return read(this.#client.config.properties({ path }).get())
  }

  sources() {
    return read(this.#client.config.sources.get())
  }

  routes() {
    return read(this.#client.routes.get())
  }

  security() {
    return read(this.#client.routes.security.get())
  }

  refreshables() {
    return read(this.#client.refreshables.get())
  }

  /** Refreshes every refreshable, or those carrying `label`. */
  refreshAll(label: string | undefined) {
    return read(this.#client.refreshables.refreshes.post({ body: label === undefined ? {} : { label } }))
  }

  refreshOne(id: string) {
    return read(this.#client.refreshables({ id }).refreshes.post({ body: {} }))
  }

  events() {
    return read(this.#client.events.get())
  }

  runtime() {
    return read(this.#client.runtime.get())
  }
}

/** The body of a `200`, or the devtools' refusal thrown. */
async function read<R extends Answer>(sent: Promise<R>): Promise<OK<R>> {
  const res = await sent

  if (res.status !== 200) {
    throw new ErrDevToolsAnswered(res.status, res.statusText)
  }

  return (await res.json()) as OK<R>
}
