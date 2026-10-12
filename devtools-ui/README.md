# `@caffeinejs/devtools-ui`

A web page for reading the DevTools of one or more running Caffeine applications: their bindings, dependency graph,
routes, health, process and configuration. It is an application of its own. It reads each application through the
DevTools endpoints the application serves, and nothing else.

## Serve DevTools from an application

DevTools is a plugin of `@caffeinejs/devtools`, registered on an ops server so it never shares a port with the
application's own API. Protect it with the application's authentication:

```ts
import { devTools } from '@caffeinejs/devtools'
import { Authentication, Ops, authentication, createWebApplication } from '@caffeinejs/http'

createWebApplication()
  .install(Authentication(a => a.addBasic('devtools', b => b.validate(checkOperator))))
  .install(
    Ops('devtools', o =>
      o
        .server(() => ({ listener: { host: '127.0.0.1', port: 9100 } }))
        .with(authentication())
        .with(devTools(d => d.authorize({ schemes: ['devtools'] }))),
    ),
  )
```

`GET /devtools` lists what is served, each slice under it: `/devtools/bindings`, `/devtools/graph`, and so on.
`devTools(d => d.slices(...))` picks the slices, and a slice of an application's own is one more value with an `id`
and its router: the UI shows a slice it has no page for as the JSON it answers with.

## Run the UI

The UI reads its configuration from a YAML file, `devtools.yaml` in the working directory unless `--config` names
another:

```sh
caffeine-devtools --config devtools.yaml
```

From this repository, build first and run the built entry point, or let make do both:

```sh
npm run build && node devtools-ui/dist/main.js --config devtools.yaml
make devtools DEVTOOLS_CONFIG=devtools.yaml
```

`make example:devtools` starts an example application, and `make devtools` with no `DEVTOOLS_CONFIG` reads that
example's `devtools.yaml`. Open `http://127.0.0.1:9339`.

## Configuration

```yaml
server:
  host: 127.0.0.1
  port: 9339

applications:
  orders:
    url: http://127.0.0.1:9100/devtools
    timeout: 5s
    auth:
      basic:
        username: ops
        password: '${env:ORDERS_DEVTOOLS_PASSWORD}'
  payments:
    url: https://payments.internal:9100/devtools
    auth:
      bearer: '${env:PAYMENTS_DEVTOOLS_TOKEN}'
    headers:
      x-tenant: acme
```

| Key                               | Default     | Meaning                                                                     |
| --------------------------------- | ----------- | --------------------------------------------------------------------------- |
| `server.host`                     | `127.0.0.1` | Where the UI listens.                                                       |
| `server.port`                     | `9339`      | The port it listens on.                                                     |
| `applications.<name>`             |             | One application, by the name its pages show: letters, digits, `_`, `-`.     |
| `applications.<name>.url`         |             | Where the application serves its DevTools index, as `devTools()` mounts it. |
| `applications.<name>.timeout`     | `5s`        | How long one call to the application may take.                              |
| `applications.<name>.auth.basic`  |             | `username` and `password`, sent as Basic credentials.                       |
| `applications.<name>.auth.bearer` |             | A token, sent as a Bearer credential.                                       |
| `applications.<name>.headers`     |             | Headers sent on every call to the application.                              |

At least one application is required. Start-up refuses a URL that carries credentials, a query or a fragment, and
an application given credentials both in `auth` and in an `authorization` header.

Write secrets as `${env:NAME}`, so they stay out of the file. Every key can also be set from the environment, prefixed
`CAFFEINE_DEVTOOLS_`, with `__` between the levels of a key: `CAFFEINE_DEVTOOLS_SERVER__PORT=9400`.

## Security

- The UI has no login of its own: whoever reaches it reads every application it is configured with, with the
  credentials its configuration holds. It listens on `127.0.0.1` by default and warns at start-up when it does not.
  Reach it through a tunnel rather than exposing it.
- Pages run no script and load nothing but their stylesheet. What an application sends is shown as text, and every
  response carries a content security policy that refuses anything else.
- Configuration values are hidden unless the application's DevTools send them, with
  `configuration(c => c.showValues())`, and those that look like secrets stay hidden even then.
