import { Router } from '@caffeinejs/http'

import { DevToolsAPI } from '../api.js'
import { kConfig } from '../app.config.js'
import { Badge, display } from '../shared/components/index.js'
import { page } from '../shared/layout/index.js'
import { drawGraph } from './graph.js'

/**
 * The container's bindings as a table and as a graph. `?internal=true` adds the framework's own bindings, and `?q=`
 * keeps the bindings whose key holds the text, and the graph to them and what they are wired to.
 */
export const diRouter = new Router('/di')
  .inject({ api: DevToolsAPI, config: kConfig })
  .get('/', async (ctx, { api, config }) => {
    const internal = ctx.req.query('internal') === 'true' ? 'true' : undefined
    const q = (ctx.req.query('q') ?? '').trim().toLowerCase()
    const [bindings, graph] = await Promise.all([api.bindings(internal), api.graph(internal)])
    const shown = q === '' ? bindings : bindings.filter(binding => binding.key.toLowerCase().includes(q))
    const keys = new Map(bindings.map(binding => [binding.id, binding.key]))
    // The whole graph unless filtered: a filtered one keeps what the kept bindings are wired to.
    const wired = new Set(shown.flatMap(binding => [binding.id, ...binding.dependencies, ...binding.dependents]))
    const svg = await drawGraph(graph, q === '' ? undefined : wired)

    return page(api, config, {
      title: 'Dependency injection',
      active: '/di',
      scripts: ['/static/graph.js'],
      body: (
        <>
          <form class="filters" method="get" action="/di">
            <input type="search" name="q" value={q} placeholder="Filter by key" />
            <label>
              <input type="checkbox" name="internal" value="true" checked={internal === 'true'} /> internal bindings
            </label>
            <button type="submit">Apply</button>
          </form>
          <h2>Graph</h2>
          {svg === '' ? (
            <p class="muted">No bindings to draw.</p>
          ) : (
            <>
              <p class="muted">Drag to move, scroll to zoom, click a binding to trace what it is wired to.</p>
              {/* Markup Graphviz drew from a DOT this server wrote, labels escaped: see `drawGraph`. */}
              <div class="di-graph">{svg}</div>
            </>
          )}
          <h2>
            Bindings <span class="muted">({shown.length})</span>
          </h2>
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Scope</th>
                <th>Depends on</th>
                <th>Used by</th>
                <th>Names</th>
                <th>Labels</th>
                <th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(binding => (
                <tr>
                  <td>
                    <code safe>{binding.key}</code>
                  </td>
                  <td safe>{binding.scope.replace(/^@caffeinejs\/di:scope\./, '')}</td>
                  <td safe>{display(binding.dependencies.map(id => keys.get(id) ?? `#${id}`))}</td>
                  <td safe>{display(binding.dependents.map(id => keys.get(id) ?? `#${id}`))}</td>
                  <td safe>{display(binding.names)}</td>
                  <td safe>{display(binding.labels)}</td>
                  <td>
                    {binding.primary ? <Badge tone="good" text="primary" /> : ''}
                    {binding.lazy ? <Badge tone="muted" text="lazy" /> : ''}
                    {binding.async ? <Badge tone="muted" text="async" /> : ''}
                    {binding.internal ? <Badge tone="warn" text="internal" /> : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ),
    })
  })
