import type { DevToolsRoute, DevToolsRouteGroup, DevToolsRoutesReport } from '@caffeinejs/devtools'

import { Badge, Layout, type Nav } from '../../pages/layout.js'

/** The routes an application's controllers and routers declared, server by server. */
export function RoutesPage(props: { nav: Nav; application: string; report: DevToolsRoutesReport }): JSX.Element {
  const servers = new Map<string, DevToolsRouteGroup[]>()

  for (const group of props.report.groups) {
    const server = group.server ?? ''
    servers.set(server, [...(servers.get(server) ?? []), group])
  }

  return (
    <Layout title={`Routes · ${props.application}`} nav={props.nav}>
      <h1>Routes</h1>
      <p class="lead">
        What controllers and routers declared. Routes a plugin registers itself, such as health probes, are not listed.
      </p>
      {[...servers].map(([server, groups]) => (
        <>
          <h2 safe>{server === '' ? "The application's server" : `Ops server "${server}"`}</h2>
          <table>
            <thead>
              <tr>
                <th>Method</th>
                <th>Path</th>
                <th>Handler</th>
                <th>Requires</th>
                <th>Produces</th>
              </tr>
            </thead>
            <tbody>
              {groups.flatMap(group =>
                group.routes.map(route => (
                  <tr>
                    <td safe>{route.methods.join(', ')}</td>
                    <td>
                      <code safe>{route.path}</code>
                    </td>
                    <td safe>{route.name === '' ? group.name : `${group.name}.${route.name}`}</td>
                    <td>
                      <Requires route={route} />
                    </td>
                    <td safe>{route.produces ?? ''}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </>
      ))}
    </Layout>
  )
}

function Requires(props: { route: DevToolsRoute }): JSX.Element {
  const { authorization, guards } = props.route

  // The schemes are the ones that would authenticate the route; on a route nothing protects, they gate nothing.
  if (!authorization.hasProtection) {
    return guards === 0 ? <Badge tone="muted">public</Badge> : <span safe>{`public, ${guards} guards`}</span>
  }

  const parts = [
    authorization.schemes.length > 0 ? `schemes ${authorization.schemes.join(', ')}` : '',
    authorization.defaultPolicy ? 'an authenticated caller' : '',
    authorization.roles.length > 0 ? `roles ${authorization.roles.map(roles => roles.join(' or ')).join(' and ')}` : '',
    authorization.policies.length > 0 ? `policies ${authorization.policies.join(', ')}` : '',
    guards > 0 ? `${guards} guards` : '',
  ].filter(part => part !== '')

  return <span safe>{parts.join('; ')}</span>
}
