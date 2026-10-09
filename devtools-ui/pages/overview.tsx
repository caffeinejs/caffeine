import type { DevToolsHealthReport, DevToolsIndex, DevToolsInfoReport } from '@caffeinejs/devtools'

import type { Outcome } from '../failure.js'
import { explain } from './failure.js'
import { bytes, uptime } from './format.js'
import { Badge, Layout, href, type Nav } from './layout.js'

/** One application at a glance: what it serves, and its process and health when it serves those. */
export function OverviewPage(props: {
  nav: Nav
  application: string
  index: DevToolsIndex
  info?: Outcome<DevToolsInfoReport>
  health?: Outcome<DevToolsHealthReport>
}): JSX.Element {
  const { application, index, info, health } = props

  return (
    <Layout title={application} nav={props.nav}>
      <h1 safe>{application}</h1>
      <p class="lead">What this application's DevTools serve.</p>
      <ul>
        {index.slices.map(slice => (
          <li>
            <a href={href(application, slice.id)} safe>
              {slice.id}
            </a>
          </li>
        ))}
      </ul>

      {info === undefined ? '' : <InfoSummary application={application} info={info} />}
      {health === undefined ? '' : <HealthSummary application={application} health={health} />}
    </Layout>
  )
}

function InfoSummary(props: { application: string; info: Outcome<DevToolsInfoReport> }): JSX.Element {
  if (!props.info.ok) {
    return <Unavailable application={props.application} what="Process" outcome={props.info} />
  }

  const report = props.info.value

  return (
    <>
      <h2>Process</h2>
      <dl>
        <dt>Name</dt>
        <dd safe>{report.name === '' ? '(unnamed)' : report.name}</dd>
        <dt>Profiles</dt>
        <dd safe>{report.profiles.length === 0 ? 'none' : report.profiles.join(', ')}</dd>
        <dt>Node.js</dt>
        <dd safe>{report.node}</dd>
        <dt>Uptime</dt>
        <dd safe>{uptime(report.uptime)}</dd>
        <dt>Heap used</dt>
        <dd safe>{bytes(report.memory.heapUsed)}</dd>
      </dl>
    </>
  )
}

function HealthSummary(props: { application: string; health: Outcome<DevToolsHealthReport> }): JSX.Element {
  if (!props.health.ok) {
    return <Unavailable application={props.application} what="Health" outcome={props.health} />
  }

  const report = props.health.value

  return (
    <>
      <h2>Health</h2>
      <dl>
        {(['liveness', 'readiness', 'startup'] as const).map(probe => (
          <>
            <dt safe>{probe}</dt>
            <dd>{report[probe].ok ? <Badge tone="ok">passing</Badge> : <Badge tone="bad">failing</Badge>}</dd>
          </>
        ))}
      </dl>
    </>
  )
}

function Unavailable(props: { application: string; what: string; outcome: Outcome<unknown> }): JSX.Element {
  if (props.outcome.ok) {
    return ''
  }

  return (
    <>
      <h2 safe>{props.what}</h2>
      <p class="muted" safe>
        {explain(props.application, props.outcome.failure).detail}
      </p>
    </>
  )
}
