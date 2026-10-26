import { Router } from '@caffeinejs/http'

import { DevToolsAPI } from '../api.js'
import { kConfig } from '../app.config.js'
import { Badge, KeyValue } from '../shared/components/index.js'
import { page, pageOf } from '../shared/layout/index.js'

/** The overview: what the application is, whether it is healthy, and every tool the devtools serve. */
export const homeRouter = new Router('/')
  .inject({ api: DevToolsAPI, config: kConfig })
  .get('/', async (_ctx, { api, config }) => {
    const [index, info, health] = await Promise.all([api.index(), api.info(), api.health()])
    const ready = health.groups.readiness.ok

    return page(api, config, {
      title: info.application.name === '' ? 'Overview' : info.application.name,
      active: '/',
      body: (
        <>
          <section class="cards">
            <div class="card">
              <h2>Health</h2>
              <p>
                <Badge tone={health.availability.live === 'correct' ? 'good' : 'bad'} text="live" />{' '}
                <Badge tone={ready ? 'good' : 'bad'} text={ready ? 'ready' : 'not ready'} />{' '}
                <Badge
                  tone={health.availability.draining ? 'warn' : 'muted'}
                  text={health.availability.draining ? 'draining' : 'serving'}
                />
              </p>
            </div>
            <div class="card">
              <h2>Application</h2>
              <KeyValue
                rows={[
                  ['profiles', info.application.profiles],
                  ['Caffeine', info.runtime.caffeine],
                  ['Node.js', info.runtime.node],
                  ['NODE_ENV', info.runtime.nodeEnv],
                ]}
              />
            </div>
          </section>
          <h2>Tools</h2>
          <ul class="tools">
            {index.tools.map(tool => (
              <li>
                <a href={pageOf(tool.id)} safe>
                  {tool.title}
                </a>
                <span safe>{tool.description}</span>
              </li>
            ))}
          </ul>
        </>
      ),
    })
  })
