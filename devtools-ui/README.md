# @caffeinejs/devtools-ui

A web UI for the [devtools](../devtools/README.md) endpoints, built as a Caffeine application. It renders HTML on the
server with `@caffeinejs/html`, reads the devtools through a `@caffeinejs/brewer` client typed by their own routes,
and draws the dependency graph with Graphviz on the server. It runs as a process of its own, next to the application
it reads.

## Run it

Install the devtools in the application:

```ts
createWebApplication().install(DevTools())
```

Then start the UI. It listens on `127.0.0.1:9091` and reads `http://127.0.0.1:9090/devtools`, which is where
`DevTools()` serves by default:

```sh
npx caffeine-devtools
# or, from this repository
make devtools
```

## Configure it

It reads environment variables prefixed `CAFFEINE_DEVTOOLS_`:

| Variable                                  | Default                          | What it sets                                                                                                      |
| ----------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `CAFFEINE_DEVTOOLS_TARGET__URL`           | `http://127.0.0.1:9090/devtools` | Where the devtools are served: the host, the port and the path                                                    |
| `CAFFEINE_DEVTOOLS_TARGET__AUTHORIZATION` | unset                            | The `Authorization` header sent with each request, such as `Bearer <token>`, for devtools behind `authorize(...)` |
| `CAFFEINE_DEVTOOLS_SERVER__HOST`          | `127.0.0.1`                      | The address the UI listens on                                                                                     |
| `CAFFEINE_DEVTOOLS_SERVER__PORT`          | `9091`                           | The port the UI listens on                                                                                        |
| `CAFFEINE_DEVTOOLS_LOG__LEVEL`            | `info`                           | The log level                                                                                                     |

Keep the UI on loopback. Anyone who reaches it sees what the devtools show, using the credentials the UI was given.
On a loopback address it answers loopback host names alone, so a page using DNS rebinding cannot read it.

## Run it in a container

The [Dockerfile](Dockerfile) builds the UI from this repository's sources, so its context is the repository root:

```sh
docker build -f devtools-ui/Dockerfile -t caffeinejs/devtools-ui .
```

The image runs Node.js 24 on a distroless base, with no shell or package manager, as a non-root user (65532). It
listens on every interface of the container, port `9091`, and is configured by the same `CAFFEINE_DEVTOOLS_`
variables. It needs no writable file system and no Linux capabilities, so `--read-only --cap-drop ALL` work. The
image does not depend on the build machine's architecture: `docker buildx build --platform linux/amd64,linux/arm64`
builds both.

`/livez`, `/readyz` and `/startupz` answer whether the UI serves, whatever the devtools answer, and the image's
`HEALTHCHECK` reads `/livez`. They are the probes to give Kubernetes.

Inside the container `127.0.0.1` is the container, so where the application runs decides how the UI reaches it.
Publish the port on loopback alone, as above, since anyone who reaches the UI reads the devtools:

```sh
# The application runs on this Linux host, with the devtools on 127.0.0.1:9090: share the host's network.
docker run --rm --network host --read-only --cap-drop ALL \
  -e CAFFEINE_DEVTOOLS_SERVER__HOST=127.0.0.1 caffeinejs/devtools-ui

# The application runs in a container named "app": share its network, and publish 9091 on that container.
docker run --rm --network container:app --read-only --cap-drop ALL caffeinejs/devtools-ui

# The devtools are served on an address the container can reach.
docker run --rm -p 127.0.0.1:9091:9091 --read-only --cap-drop ALL \
  -e CAFFEINE_DEVTOOLS_TARGET__URL=http://10.0.0.12:9090/devtools caffeinejs/devtools-ui
```

In Kubernetes, run it as a sidecar of the application's pod: the containers share `127.0.0.1`, so the defaults read
the devtools, and `kubectl port-forward` reaches the UI. Pass `CAFFEINE_DEVTOOLS_TARGET__AUTHORIZATION` from a
secret, never written in the pod spec or a `docker run` line.

## Pages

| Page                 | Shows                                                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview             | The application, whether it is live and ready, and every tool                                                                                                         |
| Info                 | The application's name, profiles and features, and the process                                                                                                        |
| Health               | Every indicator with its details, and the availability                                                                                                                |
| Dependency injection | The graph, which you can drag, zoom and click to trace a binding, and the table of bindings. Filter them by key; the framework's own bindings are included on request |
| Configuration        | Every value's path and origin, and each layer that set it. Values appear when the application shows them, with secrets masked                                         |
| Routes               | Every route of every server: its gate and schemes, its roles and policies, its guards, its cross-origin protection                                                    |
| Refreshables         | The refresh-scoped injectables, refreshed all at once, by label, or one at a time                                                                                     |
| Container events     | What the container did since the devtools attached to it                                                                                                              |
| Runtime              | CPU, event loop, heap and resident memory as shares, then memory, heap, CPU time and active resources                                                                 |

## Layout

The layout follows the petstore example: one folder per page, and `shared/` for what several pages use.

```text
devtools-ui/
  app.ts          container and application setup
  app.config.ts   configuration
  main.ts         starts the server
  api.ts          the devtools client, typed by DevToolsRoutes
  shared/         layout, error pages, components
  <page>/         one router per page
  public/         stylesheet, the script that keeps the theme and sidebar a person chose, and the script
                  that makes the graph explorable
```
