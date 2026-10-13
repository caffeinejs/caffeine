import type { DevToolsBinding, DevToolsBindingsReport } from '@caffeinejs/devtools'
import type { BindingGraph, GraphEdge } from '@caffeinejs/di/graph'

import { Badge, Layout, href, type Nav } from '../../pages/layout.js'

export interface BindingsFilter {
  /** Matched against a binding's key, names and labels, ignoring case. */
  q: string
  /** Lists what the framework bound on the application's behalf too. */
  internal: boolean
}

/** Every binding of one application, filtered by the page's query. */
export function BindingsPage(props: {
  nav: Nav
  application: string
  report: DevToolsBindingsReport
  filter: BindingsFilter
}): JSX.Element {
  const { application, report, filter } = props
  const needle = filter.q.toLowerCase()
  const shown = report.bindings.filter(
    binding =>
      (filter.internal || !binding.internal) &&
      (needle === '' ||
        [binding.key, ...binding.names, ...binding.labels].some(text => text.toLowerCase().includes(needle))),
  )
  const internal = report.bindings.filter(binding => binding.internal).length

  return (
    <Layout title={`Bindings · ${application}`} nav={props.nav}>
      <h1>Bindings</h1>
      <p class="lead" safe>
        {`${shown.length} of ${report.bindings.length}${filter.internal ? '' : `, ${internal} internal hidden`}`}
      </p>
      <form class="filters" method="get" action={href(application, 'bindings')}>
        <input type="search" name="q" value={filter.q} placeholder="Key, name or label" />
        <label>
          <input type="checkbox" name="internal" value="on" checked={filter.internal} /> Show internal
        </label>
        <button type="submit">Filter</button>
      </form>
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th>Scope</th>
            <th>Names and labels</th>
            <th>Flags</th>
            <th>Profiles</th>
          </tr>
        </thead>
        <tbody>
          {shown.map(binding => (
            <tr>
              <td>
                <a href={href(application, 'bindings', String(binding.id))}>
                  <code safe>{binding.key}</code>
                </a>
              </td>
              <td safe>{scopeOf(binding.scope)}</td>
              <td safe>{[...binding.names, ...binding.labels].join(', ')}</td>
              <td>
                <Flags binding={binding} />
              </td>
              <td safe>{binding.profiles.join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Layout>
  )
}

/**
 * One binding, with what it depends on and what depends on it, from the graph: absent when the application does not
 * serve the graph slice.
 */
export function BindingPage(props: {
  nav: Nav
  application: string
  binding: DevToolsBinding
  graph?: BindingGraph
}): JSX.Element {
  const { application, binding, graph } = props

  return (
    <Layout title={`${binding.key} · ${application}`} nav={props.nav}>
      <h1>
        <code safe>{binding.key}</code>
      </h1>
      <p class="lead">
        <Flags binding={binding} />
      </p>
      <dl>
        <dt>Scope</dt>
        <dd safe>{scopeOf(binding.scope)}</dd>
        <dt>Type</dt>
        <dd safe>{binding.type ?? '—'}</dd>
        <dt>Names</dt>
        <dd safe>{binding.names.length === 0 ? '—' : binding.names.join(', ')}</dd>
        <dt>Labels</dt>
        <dd safe>{binding.labels.length === 0 ? '—' : binding.labels.join(', ')}</dd>
        <dt>Profiles</dt>
        <dd safe>{binding.profiles.length === 0 ? 'every profile' : binding.profiles.join(', ')}</dd>
        <dt>Configured by</dt>
        <dd safe>{binding.configuredBy ?? '—'}</dd>
      </dl>

      {graph === undefined ? (
        <p class="muted">Dependencies come from the graph slice, which this application does not serve.</p>
      ) : (
        <Dependencies application={application} binding={binding} graph={graph} />
      )}
    </Layout>
  )
}

function Dependencies(props: { application: string; binding: DevToolsBinding; graph: BindingGraph }): JSX.Element {
  const { application, binding, graph } = props
  const labels = new Map(graph.nodes.map(node => [node.id, node.label]))

  return (
    <>
      <h2>Depends on</h2>
      <Edges
        application={application}
        edges={graph.edges.filter(edge => edge.fromID === binding.id)}
        end={edge => edge.toID}
        labels={labels}
      />
      <h2>Used by</h2>
      <Edges
        application={application}
        edges={graph.edges.filter(edge => edge.toID === binding.id)}
        end={edge => edge.fromID}
        labels={labels}
      />
    </>
  )
}

function Edges(props: {
  application: string
  edges: readonly GraphEdge[]
  end: (edge: GraphEdge) => number
  labels: ReadonlyMap<number, string>
}): JSX.Element {
  if (props.edges.length === 0) {
    return <p class="muted">Nothing.</p>
  }

  return (
    <ul>
      {props.edges.map(edge => {
        const id = props.end(edge)

        return (
          <li>
            <a href={href(props.application, 'bindings', String(id))}>
              <code safe>{props.labels.get(id) ?? String(id)}</code>
            </a>{' '}
            <span class="muted" safe>
              {edge.meta === undefined ? edge.kind : `${edge.kind}, ${edge.meta}`}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function Flags(props: { binding: DevToolsBinding }): JSX.Element {
  const { primary, lazy, async, internal } = props.binding

  return (
    <>
      {primary ? <Badge tone="ok">primary</Badge> : ''} {lazy ? <Badge tone="muted">lazy</Badge> : ''}{' '}
      {async ? <Badge tone="muted">async</Badge> : ''} {internal ? <Badge tone="warn">internal</Badge> : ''}
    </>
  )
}

/** The scope's own name: `singleton` out of `@caffeinejs/di:scope.singleton`. */
export function scopeOf(scope: string): string {
  return scope.replace(/^@caffeinejs\/di:scope\./, '')
}
