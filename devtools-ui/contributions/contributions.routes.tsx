import { ErrHTTPNotFound, Router } from '@caffeinejs/http'

import { DevToolsAPI } from '../api.js'
import { kConfig } from '../app.config.js'
import { JSONView } from '../shared/components/index.js'
import { page } from '../shared/layout/index.js'

/**
 * A tool a package or the application contributed: its resources listed, and each one the UI can read without a
 * parameter, at the tool's root or one segment under it, shown as JSON.
 */
export const contributionsRouter = new Router('/contributions')
  .inject({ api: DevToolsAPI, config: kConfig })
  .get('/:id', async (ctx, { api, config }) => {
    const id = ctx.req.param('id')!
    const tool = (await api.index()).tools.find(candidate => candidate.id === id)

    if (tool === undefined) {
      throw new ErrHTTPNotFound(`The devtools serve no tool "${id}"`)
    }

    const prefix = new URL(config.target.url).pathname.replace(/\/$/, '')
    const readable = tool.links.filter(link => link.method === 'GET' && !link.href.includes('/:'))
    const resources = await Promise.all(
      readable.map(async link => {
        const path = link.href.slice(prefix.length)

        // The tool's root, or a resource one segment under it.
        return path.split('/').filter(Boolean).length <= 2 ? { link, value: await api.contributed(path) } : { link }
      }),
    )

    return page(api, config, {
      title: tool.title,
      active: `/contributions/${encodeURIComponent(id)}`,
      body: (
        <>
          <p safe>{tool.description}</p>
          <h2>Resources</h2>
          <ul>
            {tool.links.map(link => (
              <li>
                <code safe>{`${link.method} ${link.href}`}</code>
              </li>
            ))}
          </ul>
          {resources.map(resource => (
            <>
              <h2>
                <code safe>{resource.link.href}</code>
              </h2>
              {'value' in resource ? (
                <JSONView value={resource.value} />
              ) : (
                <p class="muted">Nested deeper than the UI reads.</p>
              )}
            </>
          ))}
        </>
      ),
    })
  })
