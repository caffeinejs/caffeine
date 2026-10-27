import { $t, type InferSchema } from '@caffeinejs/application/schema'
import { Scopes, type Binding, type Container, type InjectionToken } from '@caffeinejs/di'
import { buildBindingGraph } from '@caffeinejs/di/graph'
import { blend, ErrHTTPBadRequest, ErrHTTPNotFound, Router } from '@caffeinejs/http'

import { ErrorSchema, type ToolInfo } from '../tool.js'

/** An injectable a refresh re-creates, or refreshes in place when it is self-refreshable. */
export const RefreshableSchema = $t.Object({
  id: $t.Integer(),
  key: $t.String(),
  /** The descriptions of its labels: what a refresh by label names. */
  labels: $t.Array($t.String()),
})

/** What a refresh reached, and when it ended. */
export const RefreshSchema = $t.Object({
  refreshed: $t.Array(RefreshableSchema),
  /** An ISO 8601 timestamp. */
  at: $t.String(),
})

export type RefreshableRecord = InferSchema<typeof RefreshableSchema>
export type RefreshRecord = InferSchema<typeof RefreshSchema>

export const refreshablesTool: ToolInfo = {
  id: 'refreshables',
  title: 'Refreshables',
  description: 'The refresh-scoped injectables, refreshed all at once, by label or one by one',
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
export function refreshablesRouter(tool: RefreshablesTool) {
  const refreshables = new Router('/refreshables')

  const list = refreshables
    .get('')
    .schema({ response: { 200: $t.Array(RefreshableSchema) } })
    .handler(() => tool.list().map(([record]) => record))

  const one = refreshables
    .get('/:id')
    .schema({ response: { 200: RefreshableSchema, 404: ErrorSchema } })
    .handler(ctx => tool.find(ctx.req.param().id)[0])

  const refreshAll = refreshables
    .post('/refreshes')
    .schema({
      body: $t.Object({ label: $t.Optional($t.String()) }, { additionalProperties: false }),
      response: { 200: RefreshSchema, 400: ErrorSchema },
    })
    .handler(ctx => tool.refreshAll(ctx.req.body().label))

  const refreshOne = refreshables
    .post('/:id/refreshes')
    // A body, though empty: a request changing something carries JSON, which a cross-site form cannot send.
    .schema({
      body: $t.Object({}, { additionalProperties: false }),
      response: { 200: RefreshSchema, 404: ErrorSchema },
    })
    .handler(ctx => tool.refreshOne(ctx.req.param().id))

  return blend(list, one, refreshAll, refreshOne)
}

/** Lists and refreshes the container's refresh-scoped injectables. */
export class RefreshablesTool {
  readonly #container: Container

  constructor(container: Container) {
    this.#container = container
  }

  /** @throws ErrHTTPBadRequest when no refresh-scoped injectable carries `label`. */
  async refreshAll(label: string | undefined): Promise<RefreshRecord> {
    const all = this.list()

    if (label === undefined) {
      await this.#container.refresher.refresh()
      return refreshed(all)
    }

    // Two modules may each write `Symbol('db')`: the label names both.
    const symbols = new Set(all.flatMap(([, binding]) => binding.labels).filter(symbol => labelText(symbol) === label))

    if (symbols.size === 0) {
      throw new ErrHTTPBadRequest(`No refresh-scoped injectable carries the label "${label}"`)
    }

    // Each binding once, though it carries more than one of them.
    const reached = all.filter(([, binding]) => binding.labels.some(symbol => symbols.has(symbol)))
    await Promise.all(reached.map(([, binding]) => this.#container.refresher.refresh(binding)))

    return refreshed(reached)
  }

  /** @throws ErrHTTPNotFound when no refresh-scoped injectable has `id`. */
  async refreshOne(id: string): Promise<RefreshRecord> {
    const found = this.find(id)

    await this.#container.refresher.refresh(found[1])
    return refreshed([found])
  }

  /** @throws ErrHTTPNotFound when no refresh-scoped injectable has `id`. */
  find(id: string): [RefreshableRecord, Binding] {
    const found = this.list().find(([record]) => String(record.id) === id)

    if (found === undefined) {
      throw new ErrHTTPNotFound(`No refresh-scoped injectable with id "${id}"`)
    }

    return found
  }

  list(): Array<[RefreshableRecord, Binding]> {
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
