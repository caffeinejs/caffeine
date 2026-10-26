# @caffeinejs/devtools

Endpoints that describe a running Caffeine application: its bindings and dependency graph, its configuration,
every route of every server and what protects each one, health, refreshable injectables, container events, the
runtime and the process. Every tool is a set of REST resources returning JSON. Packages and applications add
their own tools.

[`@caffeinejs/devtools-ui`](../devtools-ui/README.md) is a UI that reads them.

## Serve the devtools

Install them on a server of their own. By default it listens on `127.0.0.1:9090`, away from the port your users
reach:

```ts
import { DevTools } from '@caffeinejs/devtools'

const app = createWebApplication().install(DevTools())
```

```sh
curl http://127.0.0.1:9090/devtools
```

Read where they listen from the configuration. A fluent setter wins over what the configuration holds:

```ts
const app = createWebApplication({ config }).install(
  DevTools((d, { config }) => d.config(config.app.devtools)), // { host, port, path }
)
```

Or mount them on a server that already exists: the application's own server, or a listener's:

```ts
createWebApplication().with(devTools())
Listener('admin', l => l.with(devTools()))
```

## Security

The devtools show the shape of your application to anyone who can reach them, so each default holds them back:

| Default                                                                                                                                   | Change it with                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `DevTools()` listens on `127.0.0.1`.                                                                                                      | `host(...)`. A warning is logged when the host is not loopback and no `authorize(...)` is set. |
| Start-up fails with `ErrDevToolsInProduction` where `NODE_ENV` is `production`.                                                           | `allowProduction()`. A warning is logged at every start.                                       |
| Configuration values are left out: a property shows its path and its origin only.                                                         | `showConfigValues()`                                                                           |
| A `POST`, `PUT` or `PATCH` without `Content-Type: application/json` gets a 415, so a cross-site form cannot reach it without a preflight. | Nothing changes it.                                                                            |
| Every answer is sent with `Cache-Control: no-store`.                                                                                      | Nothing changes it.                                                                            |

To require something of every devtools route, use `authorize(...)`. It takes what `router.authorize(...)` takes:

```ts
createWebApplication()
  .install(Authentication(a => a.addJWTBearer(...)))
  .install(DevTools(d => d.authorize({ roles: ['ops'] })))
```

- When authentication is installed, `DevTools()` registers the authentication gate on its own server. The
  application's fallback policy then reaches the devtools as it reaches every route.
- `authorize(...)` without `Authentication(...)` fails at start-up.
- With `devTools()`, the server's own gate and fallback policy apply.

Values shown with `showConfigValues()` are masked as `******` when one of these marks them:

- **A `$t.Secret(...)` field** in the configuration schema.
- **A path segment that names a secret**: `password`, `secret`, `token`, `key`, `credential`, `auth`, `cookie`,
  `salt`, `signature`, `private`, or one that contains these words (`apiKey`, `smtpToken`).
- **A path you list with `redact(...)`**: `redact('stripe.*', 'db.url')`. `*` stands for one segment and `**`
  for any number of them.
- **The password of a URL**: `postgres://app:******@db/pets`.

## Tools

Every path below is under `/devtools`. `GET /devtools` lists every tool with links to its resources.

| Tool           | Resources                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `info`         | `GET /info`: the application's name and profiles, what its features run, the process                                                      |
| `health`       | `GET /health`, `GET /health/:group`: every indicator with its details, and the availability                                               |
| `di`           | `GET /di/bindings` (`?internal=true`), `GET /di/bindings/:id`, `GET /di/graph`: the graph plus its Mermaid source                         |
| `config`       | `GET /config/properties`, `GET /config/properties/:path`, `GET /config/sources`                                                           |
| `routes`       | `GET /routes` (`?server=<name>`, where `''` is the application's own server), `GET /routes/security`                                      |
| `refreshables` | `GET /refreshables`, `GET /refreshables/:id`, `POST /refreshables/refreshes` (`{ "label"?: string }`), `POST /refreshables/:id/refreshes` |
| `events`       | `GET /events` (`?after=<seq>`, `?limit=<n>`): the last 500 container events                                                               |
| `runtime`      | `GET /runtime`: memory, heap, CPU, event-loop utilization, active resources                                                               |

### `routes`

`routes` lists every route of every server. That includes the routes plugins mount and the raw ones, such as
health probes and static files. For each route it shows:

- the gate that authenticates it, and its schemes
- whether it is protected, with its policies and roles, and whether the fallback policy applies to it
- its guards
- what cross-origin protection does on it: `protected`, `exempt`, `excluded`, `safe` or `uncovered`

### `refreshables`

`refreshables` acts on refresh-scoped injectables (`Scopes.REFRESH`):

- A self-refreshable instance is refreshed in place.
- Any other instance is destroyed and re-created the next time it is resolved.

### `events`

`events` records what the container did after the tool attached to it:

- `DevTools()` attaches before the container initializes, so the container's start-up is recorded.
- `devTools()` attaches to a container that has already initialized, so the start-up is not recorded.

An unknown resource answers 404, and so does a method a resource does not take.

## Write a tool

Extend `DevTool` from `@caffeinejs/application/devtools` and bind the subclass so it extends `DevTool`. The
devtools serve its operations under `/devtools/<id>` and list it in the index:

```ts
import { DevTool, ErrDevToolNotFound, type DevToolOperation } from '@caffeinejs/application/devtools'

@Injectable([Queue])
export class QueueTool extends DevTool {
  readonly id = 'queue'
  readonly title = 'Job queue'
  readonly description = 'Pending jobs and the workers taking them'
  readonly operations: DevToolOperation[] = [
    { method: 'GET', path: '/jobs', handle: () => this.queue.pending() },
    {
      method: 'GET',
      path: '/jobs/:id',
      handle: ({ params }) => this.queue.find(params.id) ?? notFound(params.id),
    },
    { method: 'DELETE', path: '/jobs/:id', handle: ({ params }) => this.queue.cancel(params.id) },
  ]

  constructor(private readonly queue: Queue) {
    super()
  }
}

function notFound(id: string): never {
  throw new ErrDevToolNotFound(`No job "${id}"`)
}
```

- `@Injectable()` on a subclass extends the base class. Without the decorator, bind the subclass by hand:
  `container.bind(QueueTool, t => t.toSelf().extends(DevTool))`.
- A handler's return value is sent as JSON. Use `status` to set the status of a success. A handler that returns
  nothing is answered with 204.
- To refuse, throw `ErrDevToolNotFound` (404) or `ErrDevToolInvalid` (400). Their message is the response body.
- An id is lower-case letters, digits and dashes. Start-up fails with `ErrDevToolsConfiguration` when two tools
  share an id, when a path is malformed, or when two operations answer the same method and path.
