import { Router } from '@caffeinejs/http'

import { DevToolsAPI } from '../api.js'
import { kConfig } from '../app.config.js'
import { Badge, display } from '../shared/components/index.js'
import { page } from '../shared/layout/index.js'

/** What the container did since the devtools attached to it, newest first. */
export const eventsRouter = new Router('/events')
  .inject({ api: DevToolsAPI, config: kConfig })
  .get('/', async (_ctx, { api, config }) => {
    const events = (await api.events()).reverse()

    return page(api, config, {
      title: 'Container events',
      active: '/events',
      body: (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>At</th>
              <th>Event</th>
              <th>Subject</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {events.map(event => (
              <tr>
                <td safe>{String(event.seq)}</td>
                <td safe>{event.at}</td>
                <td>
                  <Badge tone={event.error === undefined ? 'muted' : 'bad'}>{event.kind}</Badge>
                </td>
                <td>
                  <code safe>{display(event.subject)}</code>
                </td>
                <td safe>{display(event.error)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ),
    })
  })
