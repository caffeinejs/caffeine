import type { RouteRecord } from '@caffeinejs/http'
import { Router } from '@caffeinejs/http'

import { DevToolsAPI } from '../api.js'
import { kConfig } from '../app.config.js'
import { Badge, display } from '../shared/components/index.js'
import { page } from '../shared/layout/index.js'

/**
 * Every route of every server and what each requires, with what protects the application as a whole above it. A
 * route nothing authenticates, authorizes or guards is marked, since that is what a reviewer looks for.
 */
export const routesRouter = new Router('/routes')
  .inject({ api: DevToolsAPI, config: kConfig })
  .get('/', async (ctx, { api, config }) => {
    const only = ctx.req.query('server')
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
            <select name="server">
              <option value="">every server</option>
              {servers.map(server => (
                <option value={server.server} selected={server.server === only} safe>
                  {server.server === '' ? "the application's own" : server.server}
                </option>
              ))}
            </select>
            <button type="submit">Show</button>
          </form>
          {shown.map(server => (
            <>
              <h2 safe>{server.server === '' ? "The application's own server" : `Listener ${server.server}`}</h2>
              <p class="muted" safe>
                {`Gates: ${display(security.gates.find(gate => gate.server === server.server)?.gates)}${server.basePath === '' ? '' : ` · base path ${server.basePath}`}`}
              </p>
              <table>
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
                        <code safe>{route.url}</code> {route.kind === 'raw' ? <Badge tone="muted">raw</Badge> : ''}
                      </td>
                      <td safe>{display([route.group, route.handler].filter(Boolean).join('.'))}</td>
                      <td>{authentication(route)}</td>
                      <td>{authorization(route)}</td>
                      <td safe>{display(route.security.guards)}</td>
                      <td>
                        <Badge
                          tone={
                            route.security.csrf === 'protected' || route.security.csrf === 'safe'
                              ? 'good'
                              : route.security.csrf === 'uncovered'
                                ? 'warn'
                                : 'muted'
                          }
                        >
                          {route.security.csrf}
                        </Badge>
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

function authentication(route: RouteRecord): JSX.Element {
  const auth = route.security.authentication

  if (auth.skipped) {
    return <Badge tone="muted">exempt</Badge>
  }

  if (auth.gate === undefined) {
    return <Badge tone="warn">no gate</Badge>
  }

  return (
    <span safe>{`${auth.gate}: ${display(auth.schemes)}${auth.allowAnonymous ? ' (anonymous allowed)' : ''}`}</span>
  )
}

function authorization(route: RouteRecord): JSX.Element {
  const authz = route.security.authorization

  if (!authz.protected) {
    return <Badge tone={route.security.authentication.skipped ? 'muted' : 'warn'}>open</Badge>
  }

  const required = [
    ...authz.policies.map(policy => `policy ${policy}`),
    ...authz.roleGroups.map(roles => `role ${roles.join(' or ')}`),
    ...(authz.defaultPolicy ? ['default policy'] : []),
    ...(authz.fallback ? ['fallback policy'] : []),
  ]

  return <span safe>{required.length === 0 ? 'authenticated' : required.join(', ')}</span>
}
