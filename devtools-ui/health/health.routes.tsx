import { Router } from '@caffeinejs/http'

import { DevToolsAPI } from '../api.js'
import { kConfig } from '../app.config.js'
import { Badge, KeyValue, display } from '../shared/components/index.js'
import { page } from '../shared/layout/index.js'

/** How an indicator's status reads on its badge. */
const STATUS_TONE = { up: 'good', degraded: 'warn', down: 'bad' } as const

/** Whether the application is live and ready, and every health indicator with its details. */
export const healthRouter = new Router('/health')
  .inject({ api: DevToolsAPI, config: kConfig })
  .get('/', async (_ctx, { api, config }) => {
    const health = await api.health()

    return page(api, config, {
      title: 'Health',
      active: '/health',
      body: (
        <>
          <KeyValue rows={Object.entries(health.availability)} />
          {Object.entries(health.groups).map(([group, probe]) => (
            <>
              <h2>
                <span safe>{group}</span> <Badge tone={probe.ok ? 'good' : 'bad'} text={probe.ok ? 'ok' : 'failing'} />
              </h2>
              <table>
                <thead>
                  <tr>
                    <th>Check</th>
                    <th>Status</th>
                    <th>Detail</th>
                    <th>Data</th>
                  </tr>
                </thead>
                <tbody>
                  {probe.checks.map(check => (
                    <tr>
                      <td safe>{check.name}</td>
                      <td>
                        <Badge tone={check.ok ? 'good' : 'bad'} text={check.ok ? 'ok' : 'failing'} />
                      </td>
                      <td safe>{display(check.detail)}</td>
                      <td />
                    </tr>
                  ))}
                  {probe.outcomes.map(outcome => (
                    <tr>
                      <td safe>{`${outcome.name}${outcome.critical ? '' : ' (not critical)'}`}</td>
                      <td>
                        <Badge tone={STATUS_TONE[outcome.status]} text={outcome.status} />
                      </td>
                      <td safe>{display(outcome.detail)}</td>
                      <td>
                        <code safe>{display(outcome.data)}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ))}
        </>
      ),
    })
  })
