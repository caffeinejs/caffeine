import { Router } from '@caffeinejs/http'

import { DevToolsAPI } from '../api.js'
import { kConfig } from '../app.config.js'
import { Badge, display } from '../shared/components/index.js'
import { page } from '../shared/layout/index.js'

/**
 * The configuration: every value's path and origin, the values themselves when the devtools show them, and the
 * sources. A path opens every layer that set it.
 */
export const configRouter = new Router('/config')
  .inject({ api: DevToolsAPI, config: kConfig })
  .get('/', async (_ctx, { api, config }) => {
    const [properties, sources] = await Promise.all([api.properties(), api.sources()])
    const shown = properties.some(property => 'value' in property)

    return page(api, config, {
      title: 'Configuration',
      active: '/config',
      body: (
        <>
          {shown ? (
            ''
          ) : (
            <p class="muted">
              Values are hidden. The application shows them with <code>showConfigValues()</code>, secrets masked.
            </p>
          )}
          <table>
            <thead>
              <tr>
                <th>Path</th>
                {shown ? <th>Value</th> : ''}
                <th>Origin</th>
              </tr>
            </thead>
            <tbody>
              {properties.map(property => (
                <tr>
                  <td>
                    <a href={`/config/${encodeURIComponent(property.path)}`}>
                      <code safe>{property.path}</code>
                    </a>{' '}
                    {property.secret ? <Badge tone="warn" text="secret" /> : ''}
                  </td>
                  {shown ? (
                    <td>
                      <code safe>{display(property.value)}</code>
                    </td>
                  ) : (
                    ''
                  )}
                  <td safe>{property.origin}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2>Sources</h2>
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Reloads on</th>
                <th>Keys</th>
                <th>Last loaded</th>
                <th>Failures</th>
              </tr>
            </thead>
            <tbody>
              {sources.map(source => (
                <tr>
                  <td safe>{source.name}</td>
                  <td safe>{source.trigger}</td>
                  <td safe>{String(source.keys)}</td>
                  <td safe>{source.lastLoadedAt === 0 ? 'never' : new Date(source.lastLoadedAt).toISOString()}</td>
                  <td>
                    {source.consecutiveFailures === 0 ? (
                      '0'
                    ) : (
                      <Badge tone="bad" text={`${source.consecutiveFailures}: ${source.lastError ?? ''}`} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ),
    })
  })
  .get('/:path', async (ctx, { api, config }) => {
    const property = await api.property(ctx.req.param('path')!)

    return page(api, config, {
      title: property.path,
      active: '/config',
      body: (
        <>
          <p>
            <a href="/config">All values</a>
          </p>
          <table>
            <thead>
              <tr>
                <th>Layer</th>
                <th>Origin</th>
                {'value' in property ? <th>Value</th> : ''}
              </tr>
            </thead>
            <tbody>
              {property.layers.map((layer, at) => (
                <tr class={at === 0 ? 'winner' : ''}>
                  <td safe>{layer.layer}</td>
                  <td safe>{layer.origin}</td>
                  {'value' in property ? (
                    <td>
                      <code safe>{display(layer.value)}</code>
                    </td>
                  ) : (
                    ''
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {property.layers.length === 0 ? <p class="muted">No layer sets it: the schema's default applies.</p> : ''}
        </>
      ),
    })
  })
