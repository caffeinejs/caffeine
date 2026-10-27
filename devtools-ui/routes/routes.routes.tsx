import type { ServerRoutesRecord } from '@caffeinejs/devtools'
import { Router } from '@caffeinejs/http'

import { DevToolsAPI } from '../api.js'
import { kConfig } from '../app.config.js'
import { Badge, Table, display } from '../shared/components/index.js'
import { page } from '../shared/layout/index.js'

const EVERY_SERVER = '*'

type RouteRecord = ServerRoutesRecord['routes'][number]

/** How cross-origin protection on a route reads on its badge: a route nothing covers is what a reviewer looks for. */
const CSRF_TONE = { protected: 'good', safe: 'good', uncovered: 'warn', exempt: 'muted', excluded: 'muted' } as const

/**
 * Every route of every server and what each requires, with what protects the application as a whole above it. A
 * route nothing authenticates, authorizes or guards is marked, since that is what a reviewer looks for.
 */
export const routesRouter = new Router('/routes')
  .inject({ api: DevToolsAPI, config: kConfig })
  .get('/', async (ctx, { api, config }) => {
    // `''` names the application's own server, so every server is `*`, or no filter at all.
    const asked = ctx.req.query('server')
    const only = asked === EVERY_SERVER ? undefined : asked
    const [servers, security] = await Promise.all([api.routes(), api.security()])
    const shown = only === undefined ? servers : servers.filter(server => server.server === only)

    return page(api, config, {
      title: 'Routes',
      active: '/routes',
      body: (
        <>
          <section class="cards">
            <div class="card">
              <h2>Authentication</h2>
              <p safe>{`Schemes: ${display(security.authentication.schemes)}`}</p>
              <p safe>{`Default: ${display(security.authentication.defaultScheme)}`}</p>
            </div>
            <div class="card">
              <h2>Authorization</h2>
              <p
                safe
              >{`Fallback policy: ${security.authorization.fallbackPolicy ?? 'none, undeclared routes are open'}`}</p>
              <p safe>{`Left open by it: ${display(security.authorization.fallbackExcept)}`}</p>
            </div>
          </section>
          <form class="filters" method="get" action="/routes">
            <select name="server" aria-label="Server">
              <option value={EVERY_SERVER} selected={only === undefined}>
                every server
              </option>
              {servers.map(server => (
                <option value={server.server} selected={server.server === only} safe>
                  {server.server === '' ? "the application's own" : server.server}
                </option>
              ))}
            </select>
            <button type="submit" class="primary">
              Show
            </button>
          </form>
          {shown.map(server => (
            <>
              <h2 safe>{server.server === '' ? "The application's own server" : `Listener ${server.server}`}</h2>
              <p class="muted" safe>
                {`Gates: ${display(security.gates.find(gate => gate.server === server.server)?.gates)}${basePathOf(server)}`}
              </p>
              <Table>
                <thead>
                  <tr>
                    <th>Method</th>
                    <th>Path</th>
                    <th>Handler</th>
                    <th>Authentication</th>
                    <th>Authorization</th>
                    <th>Guards</th>
                    <th>CSRF</th>
                  </tr>
                </thead>
                <tbody>
                  {server.routes.map(route => (
                    <tr>
                      <td safe>{route.methods.join(' ')}</td>
                      <td>
                        <code safe>{route.url}</code> {route.kind === 'raw' ? <Badge tone="muted" text="raw" /> : ''}
                      </td>
                      <td safe>{display([route.group, route.handler].filter(Boolean).join('.'))}</td>
                      <td>{authentication(route)}</td>
                      <td>{authorization(route)}</td>
                      <td safe>{display(route.security.guards)}</td>
                      <td>
                        <Badge tone={CSRF_TONE[route.security.csrf]} text={route.security.csrf} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </>
          ))}
        </>
      ),
    })
  })

function basePathOf(server: ServerRoutesRecord): string {
  return server.basePath === '' ? '' : ` · base path ${server.basePath}`
}

function authentication(route: RouteRecord): JSX.Element {
  const auth = route.security.authentication

  if (auth.skipped) {
    return <Badge tone="muted" text="exempt" />
  }

  if (auth.gate === undefined) {
    return <Badge tone="warn" text="no gate" />
  }

  return (
    <span safe>{`${auth.gate}: ${display(auth.schemes)}${auth.allowAnonymous ? ' (anonymous allowed)' : ''}`}</span>
  )
}

function authorization(route: RouteRecord): JSX.Element {
  const authz = route.security.authorization

  if (!authz.protected) {
    return <Badge tone={route.security.authentication.skipped ? 'muted' : 'warn'} text="open" />
  }

  const required = [
    ...authz.policies.map(policy => `policy ${policy}`),
    ...authz.roleGroups.map(roles => `role ${roles.join(' or ')}`),
    ...(authz.defaultPolicy ? ['default policy'] : []),
    ...(authz.fallback ? ['fallback policy'] : []),
  ]

  return <span safe>{required.length === 0 ? 'authenticated' : required.join(', ')}</span>
}
