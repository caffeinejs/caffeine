import type { DevToolsInfoReport } from '@caffeinejs/devtools'

import { bytes, uptime } from '../../pages/format.js'
import { Layout, type Nav } from '../../pages/layout.js'

/** Who an application is and the process it runs in. */
export function InfoPage(props: { nav: Nav; application: string; report: DevToolsInfoReport }): JSX.Element {
  const { report } = props

  return (
    <Layout title={`Info · ${props.application}`} nav={props.nav}>
      <h1>Info</h1>
      <dl>
        <dt>Name</dt>
        <dd safe>{report.name === '' ? '(unnamed)' : report.name}</dd>
        <dt>Profiles</dt>
        <dd safe>{report.profiles.length === 0 ? 'none' : report.profiles.join(', ')}</dd>
        <dt>Node.js</dt>
        <dd safe>{report.node}</dd>
        <dt>Platform</dt>
        <dd safe>{report.platform}</dd>
        <dt>Process</dt>
        <dd safe>{String(report.pid)}</dd>
        <dt>Uptime</dt>
        <dd safe>{uptime(report.uptime)}</dd>
      </dl>
      <h2>Memory</h2>
      <dl>
        <dt>Resident</dt>
        <dd safe>{bytes(report.memory.rss)}</dd>
        <dt>Heap used</dt>
        <dd safe>{`${bytes(report.memory.heapUsed)} of ${bytes(report.memory.heapTotal)}`}</dd>
        <dt>External</dt>
        <dd safe>{bytes(report.memory.external)}</dd>
        <dt>Array buffers</dt>
        <dd safe>{bytes(report.memory.arrayBuffers)}</dd>
      </dl>
    </Layout>
  )
}
