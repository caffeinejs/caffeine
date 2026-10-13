import type { DevToolsIndex } from '@caffeinejs/devtools'

import type { Outcome } from '../failure.js'
import { explain } from './failure.js'
import { Badge, Layout, href, type Nav } from './layout.js'

export interface HomeRow {
  name: string
  index: Outcome<DevToolsIndex>
}

/** Every configured application, and whether its DevTools answered. */
export function HomePage(props: { nav: Nav; rows: readonly HomeRow[] }): JSX.Element {
  return (
    <Layout title="Applications" nav={props.nav}>
      <h1>Applications</h1>
      <p class="lead">Every application the configuration lists, and whether its DevTools answer.</p>
      <table>
        <thead>
          <tr>
            <th>Application</th>
            <th>Status</th>
            <th>Slices</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map(({ name, index }) => (
            <tr>
              <td>
                <a href={href(name)} safe>
                  {name}
                </a>
              </td>
              <td>{index.ok ? <Badge tone="ok">up</Badge> : <Badge tone="bad">{label(name, index)}</Badge>}</td>
              <td>
                {index.ok ? (
                  <span safe>{index.value.slices.map(slice => slice.id).join(', ')}</span>
                ) : (
                  <span class="muted" safe>
                    {explain(name, index.failure).detail}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Layout>
  )
}

function label(name: string, index: Outcome<DevToolsIndex> & { ok: false }): string {
  const { title } = explain(name, index.failure)
  return index.failure.status === undefined ? title : `${title} (${index.failure.status})`
}
