import { Scopes, type Binding, type Container, type InjectionToken } from '@caffeinejs/di'
import { buildBindingGraph } from '@caffeinejs/di/graph'
import { ErrHTTPBadRequest, ErrHTTPNotFound } from '@caffeinejs/http'

import type { ToolInfo } from '../tool.js'
import type { RefreshableRecord, RefreshRecord } from './refreshables.schema.js'

export const refreshablesTool: ToolInfo = {
  id: 'refreshables',
  title: 'Refreshables',
  description: 'The refresh-scoped injectables, refreshed all at once, by label or one by one',
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
