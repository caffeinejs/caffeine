import { DevTool, ErrDevToolInvalid, ErrDevToolNotFound, type DevToolOperation } from '@caffeinejs/application/devtools'
import { Scopes, type Binding, type Container, type InjectionToken } from '@caffeinejs/di'
import { buildBindingGraph } from '@caffeinejs/di/graph'

/** An injectable a refresh re-creates, or refreshes in place when it is self-refreshable. */
export interface RefreshableRecord {
  readonly id: number
  readonly key: string
  /** The descriptions of its labels: what a refresh by label names. */
  readonly labels: readonly string[]
}

/** What a refresh reached, and when it ended. */
export interface RefreshRecord {
  readonly refreshed: readonly RefreshableRecord[]
  /** An ISO 8601 timestamp. */
  readonly at: string
}

/**
 * The refresh-scoped injectables, and refreshing them: all of them, those carrying a label, or one. A
 * self-refreshable instance refreshes in place; any other is destroyed and re-created on its next resolution.
 *
 * - `GET /refreshables`: every refresh-scoped injectable
 * - `GET /refreshables/:id`: one
 * - `POST /refreshables/refreshes`: refreshes every one, or those whose label `{ "label": "..." }` names
 * - `POST /refreshables/:id/refreshes`: refreshes that one
 */
export class RefreshablesTool extends DevTool {
  readonly id = 'refreshables'
  readonly title = 'Refreshables'
  readonly description = 'The refresh-scoped injectables, refreshed all at once, by label or one by one'
  readonly operations: readonly DevToolOperation[]

  readonly #container: Container

  constructor(container: Container) {
    super()
    this.#container = container
    this.operations = [
      { method: 'GET', path: '', handle: () => this.#list().map(([record]) => record) },
      { method: 'GET', path: '/:id', handle: ({ params }) => this.#find(params.id)[0] },
      { method: 'POST', path: '/refreshes', handle: ({ body }) => this.#refreshAll(labelOf(body)) },
      { method: 'POST', path: '/:id/refreshes', handle: ({ params }) => this.#refreshOne(params.id) },
    ]
  }

  async #refreshAll(label: string | undefined): Promise<RefreshRecord> {
    const all = this.#list()

    if (label === undefined) {
      await this.#container.refresher.refresh()
      return refreshed(all)
    }

    // Two modules may each write `Symbol('db')`: the label names both.
    const symbols = new Set(all.flatMap(([, binding]) => binding.labels).filter(symbol => labelText(symbol) === label))

    if (symbols.size === 0) {
      throw new ErrDevToolInvalid(`No refresh-scoped injectable carries the label "${label}"`)
    }

    for (const symbol of symbols) {
      await this.#container.refresher.refresh(symbol)
    }

    return refreshed(all.filter(([, binding]) => binding.labels.some(symbol => symbols.has(symbol))))
  }

  async #refreshOne(id: string): Promise<RefreshRecord> {
    const found = this.#find(id)

    await this.#container.refresher.refresh(found[1])
    return refreshed([found])
  }

  #find(id: string): [RefreshableRecord, Binding] {
    const found = this.#list().find(([record]) => String(record.id) === id)

    if (found === undefined) {
      throw new ErrDevToolNotFound(`No refresh-scoped injectable with id "${id}"`)
    }

    return found
  }

  #list(): Array<[RefreshableRecord, Binding]> {
    const entries = Array.from(this.#container.entries()).filter(
      ([, binding]) => binding.scopeID === Scopes.REFRESH,
    ) as Array<[InjectionToken, Binding]>
    const keys = new Map(buildBindingGraph(entries).nodes.map(node => [node.id, node.label]))

    return entries.map(([, binding]) => [
      {
        id: binding.id,
        key: keys.get(binding.id)!,
        labels: binding.labels.map(labelText),
      },
      binding,
    ])
  }
}

function refreshed(entries: ReadonlyArray<[RefreshableRecord, Binding]>): RefreshRecord {
  return { refreshed: entries.map(([record]) => record), at: new Date().toISOString() }
}

/** A label as the list shows it and a refresh names it. */
function labelText(label: symbol): string {
  return label.description ?? String(label)
}

function labelOf(body: unknown): string | undefined {
  if (body === undefined || body === null) {
    return undefined
  }

  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new ErrDevToolInvalid('Cannot refresh: the body must be a JSON object')
  }

  const label = (body as { label?: unknown }).label

  if (label !== undefined && typeof label !== 'string') {
    throw new ErrDevToolInvalid('Cannot refresh: "label" must be a string')
  }

  return label
}
