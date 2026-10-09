import type { DevToolsConfigEntry, DevToolsConfigurationReport } from '@caffeinejs/devtools'

import { milliseconds, timestamp } from '../../pages/format.js'
import { Badge, Layout, type Nav } from '../../pages/layout.js'

/** Where an application's configuration came from, and which source set each value. */
export function ConfigurationPage(props: {
  nav: Nav
  application: string
  report: DevToolsConfigurationReport
}): JSX.Element {
  const { report } = props

  return (
    <Layout title={`Configuration · ${props.application}`} nav={props.nav}>
      <h1>Configuration</h1>
      <p class="lead" safe>
        {`Revision ${report.revision}, profiles ${report.profiles.length === 0 ? 'none' : report.profiles.join(', ')}. ${
          report.showsValues
            ? 'Values that look like secrets are withheld.'
            : 'Values are withheld: the application does not show them.'
        }`}
      </p>
      <h2>Sources</h2>
      <table>
        <thead>
          <tr>
            <th>Source</th>
            <th>Reloads</th>
            <th>Keys</th>
            <th>Loaded</th>
            <th>Took</th>
            <th>Failures</th>
          </tr>
        </thead>
        <tbody>
          {report.sources.map(source => (
            <tr>
              <td safe>{source.name}</td>
              <td safe>{source.trigger}</td>
              <td safe>{String(source.keys)}</td>
              <td safe>{timestamp(source.lastLoadedAt)}</td>
              <td safe>{milliseconds(source.lastLoadMs)}</td>
              <td>
                {source.consecutiveFailures === 0 ? (
                  ''
                ) : (
                  <>
                    <Badge tone="bad">{String(source.consecutiveFailures)}</Badge>{' '}
                    <span class="muted" safe>
                      {source.lastError ?? ''}
                    </span>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Values</h2>
      <table>
        <thead>
          <tr>
            <th>Path</th>
            <th>Value</th>
            <th>Set by</th>
            <th>Origin</th>
          </tr>
        </thead>
        <tbody>
          {report.entries.map(entry => (
            <tr>
              <td>
                <code safe>{entry.path}</code>
              </td>
              <td>
                <Value entry={entry} shown={report.showsValues} />
              </td>
              <td safe>{entry.layer ?? 'default'}</td>
              <td safe>{entry.origin ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Layout>
  )
}

function Value(props: { entry: DevToolsConfigEntry; shown: boolean }): JSX.Element {
  if (!props.shown) {
    return <span class="muted">hidden</span>
  }

  if (props.entry.masked === true) {
    return <Badge tone="warn">masked</Badge>
  }

  return <code safe>{JSON.stringify(props.entry.value)}</code>
}
