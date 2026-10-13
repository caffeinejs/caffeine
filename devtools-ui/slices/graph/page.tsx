import { graphToMermaid, type BindingGraph } from '@caffeinejs/di/graph'

import { Layout, href, type Nav } from '../../pages/layout.js'

/**
 * The dependency graph as adjacency lists, each binding with what it depends on, and as Mermaid source to draw it
 * with. Internal bindings are left out unless asked for, when the bindings slice says which they are.
 */
export function GraphPage(props: {
  nav: Nav
  application: string
  graph: BindingGraph
  /** The ids of internal bindings, when the application serves the bindings slice. */
  internal?: ReadonlySet<number>
  showInternal: boolean
  /** Whether binding pages exist to link to: the application serves the bindings slice. */
  linkBindings: boolean
}): JSX.Element {
  const { application, graph, internal, showInternal, linkBindings } = props
  const hidden = showInternal || internal === undefined ? new Set<number>() : internal

  const nodes = graph.nodes.filter(node => !hidden.has(node.id))
  const edges = graph.edges.filter(edge => !hidden.has(edge.fromID) && !hidden.has(edge.toID))
  const labels = new Map(nodes.map(node => [node.id, node.label]))

  const name = (id: number): JSX.Element =>
    linkBindings ? (
      <a href={href(application, 'bindings', String(id))}>
        <code safe>{labels.get(id) ?? String(id)}</code>
      </a>
    ) : (
      <code safe>{labels.get(id) ?? String(id)}</code>
    )

  return (
    <Layout title={`Graph · ${application}`} nav={props.nav}>
      <h1>Dependency graph</h1>
      <p class="lead" safe>
        {`${nodes.length} bindings, ${edges.length} edges${hidden.size > 0 ? `, ${hidden.size} internal bindings hidden` : ''}`}
      </p>
      {internal === undefined ? (
        ''
      ) : (
        <form class="filters" method="get" action={href(application, 'graph')}>
          <label>
            <input type="checkbox" name="internal" value="on" checked={showInternal} /> Show internal
          </label>
          <button type="submit">Apply</button>
        </form>
      )}
      <ul class="adjacency">
        {nodes.map(node => {
          const out = edges.filter(edge => edge.fromID === node.id)

          return (
            <li>
              {name(node.id)}
              {out.length === 0 ? (
                ''
              ) : (
                <ul>
                  {out.map(edge => (
                    <li>
                      {name(edge.toID)}{' '}
                      <span class="muted" safe>
                        {edge.meta === undefined ? edge.kind : `${edge.kind}, ${edge.meta}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
      <details>
        <summary>Mermaid source</summary>
        <pre safe>{graphToMermaid({ nodes, edges })}</pre>
      </details>
    </Layout>
  )
}
