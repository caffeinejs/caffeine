import { Router } from '@caffeinejs/http'

import { DevToolsAPI } from '../api.js'
import { kConfig } from '../app.config.js'
import { display } from '../shared/components/index.js'
import { page } from '../shared/layout/index.js'

/**
 * The refresh-scoped injectables, refreshed all at once, by label or one by one. Each refresh is a form posted to
 * the UI, which asks the devtools and comes back here naming what it refreshed.
 */
export const refreshablesRouter = new Router('/refreshables')
  .inject({ api: DevToolsAPI, config: kConfig })
  .get('/', async (ctx, { api, config }) => {
    const refreshables = await api.refreshables()
    const labels = [...new Set(refreshables.flatMap(entry => entry.labels))]
    const refreshed = ctx.req.query('refreshed')

    return page(api, config, {
      title: 'Refreshables',
      active: '/refreshables',
      body: (
        <>
          {refreshed === undefined ? '' : <p class="notice" safe>{`Refreshed: ${refreshed}`}</p>}
          <form class="filters" method="post" action="/refreshables/refreshes">
            <select name="label">
              <option value="">every refreshable</option>
              {labels.map(label => (
                <option value={label} safe>
                  {`label ${label}`}
                </option>
              ))}
            </select>
            <button type="submit">Refresh</button>
          </form>
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Labels</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {refreshables.map(entry => (
                <tr>
                  <td>
                    <code safe>{entry.key}</code>
                  </td>
                  <td safe>{display(entry.labels)}</td>
                  <td>
                    <form method="post" action={`/refreshables/${entry.id}/refreshes`}>
                      <button type="submit">Refresh</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {refreshables.length === 0 ? <p class="muted">No injectable is refresh-scoped.</p> : ''}
        </>
      ),
    })
  })
  .post('/refreshes', async (ctx, { api }) => {
    const label = (ctx.req.body() as { label?: string } | undefined)?.label
    const result = await api.refreshAll(label === undefined || label === '' ? {} : { label })

    return ctx.redirect(`/refreshables?refreshed=${encodeURIComponent(keysOf(result.refreshed))}`, 303)
  })
  .post('/:id/refreshes', async (ctx, { api }) => {
    const result = await api.refreshOne(ctx.req.param('id')!, {})

    return ctx.redirect(`/refreshables?refreshed=${encodeURIComponent(keysOf(result.refreshed))}`, 303)
  })

function keysOf(entries: ReadonlyArray<{ key: string }>): string {
  return entries.length === 0 ? 'nothing' : entries.map(entry => entry.key).join(', ')
}
