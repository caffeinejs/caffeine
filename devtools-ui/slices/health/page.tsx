import type { DevToolsHealthReport, DevToolsProbe } from '@caffeinejs/devtools'

import { milliseconds } from '../../pages/format.js'
import { Badge, Layout, type Nav } from '../../pages/layout.js'

const TONES = { up: 'ok', degraded: 'warn', down: 'bad' } as const

/** An application's availability, and each probe with every indicator's outcome. */
export function HealthPage(props: { nav: Nav; application: string; report: DevToolsHealthReport }): JSX.Element {
  const { availability } = props.report

  return (
    <Layout title={`Health · ${props.application}`} nav={props.nav}>
      <h1>Health</h1>
      <dl>
        <dt>Started</dt>
        <dd safe>{availability.started ? 'yes' : 'no'}</dd>
        <dt>Liveness</dt>
        <dd safe>{withReason(availability.live, availability.livenessReason)}</dd>
        <dt>Readiness</dt>
        <dd safe>{withReason(availability.ready, availability.readinessReason)}</dd>
        <dt>Draining</dt>
        <dd safe>{availability.draining ? 'yes' : 'no'}</dd>
      </dl>
      <Probe name="Liveness" probe={props.report.liveness} />
      <Probe name="Readiness" probe={props.report.readiness} />
      <Probe name="Startup" probe={props.report.startup} />
    </Layout>
  )
}

function Probe(props: { name: string; probe: DevToolsProbe }): JSX.Element {
  const { probe } = props

  return (
    <>
      <h2>
        <span safe>{props.name}</span> {probe.ok ? <Badge tone="ok">passing</Badge> : <Badge tone="bad">failing</Badge>}
      </h2>
      <table>
        <thead>
          <tr>
            <th>Check</th>
            <th>Status</th>
            <th>Detail</th>
            <th>Took</th>
          </tr>
        </thead>
        <tbody>
          {probe.checks.map(check => (
            <tr>
              <td safe>{check.name}</td>
              <td>{check.ok ? <Badge tone="ok">ok</Badge> : <Badge tone="bad">failing</Badge>}</td>
              <td safe>{check.detail ?? ''}</td>
              <td></td>
            </tr>
          ))}
          {probe.indicators.map(indicator => (
            <tr>
              <td safe>{indicator.name}</td>
              <td>
                <Badge tone={TONES[indicator.status]}>{indicator.status}</Badge>{' '}
                {indicator.critical ? '' : <Badge tone="muted">not critical</Badge>}
              </td>
              <td safe>{indicator.detail ?? ''}</td>
              <td safe>{milliseconds(indicator.durationMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

function withReason(state: string, reason: string | undefined): string {
  return reason === undefined ? state : `${state}: ${reason}`
}
