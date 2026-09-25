# Running under Platformatic Watt

[Watt](https://docs.platformatic.dev) runs each application of a project in worker threads, routes traffic between
them in process, and answers the orchestrator's health probes on a server of its own. A Caffeine application fits
it at three points: it answers Watt's health checks from its `ApplicationHealth`, it is started in the mode that
suits it, and it exports the `close()` Watt stops it with.

Everything below was run against Watt 3.70.0. [`examples/05-watt`](../examples/05-watt) is the working version
of each snippet: an HTTP entrypoint, an internal HTTP application and a headless worker in one runtime.

## What Watt asks of an application

- **Health probes live on Watt's server, not yours.** `/ready` and `/status`, on port 9090 by default, and only
  when the runtime's `watt.json` has a `metrics` block or a `healthProbes` object. They are not authenticated.

  ```json
  { "healthProbes": { "hostname": "0.0.0.0", "port": 9090 } }
  ```

- **`/ready` covers the whole runtime.** It passes when every application has a started worker _and_ every
  worker's readiness check passes, so a critical indicator failing in any one application takes the pod out of
  rotation. `/status` runs all of that too, then every worker's health check: whenever readiness fails, Watt's
  liveness fails with it.
- **A check is a function Watt calls on every probe request.** `setCustomReadinessCheck(fn)` and
  `setCustomHealthCheck(fn)` from `@platformatic/globals`, which set it on the global Watt installs in each worker.
  `fn` takes no arguments and returns a boolean, or `{ status, statusCode?, body? }`. Watt caches nothing, times the
  call out at `metrics.healthChecksTimeouts` (5 s) without cancelling it, and turns a throw into a 500 for the whole
  probe.
  Watt's schema marks that key deprecated, but the runtime still reads it.
- **Workers never receive a signal.** Watt handles `SIGTERM` in its main thread, then stops each worker by
  awaiting the entry module's exported `close()` and closing what it started — the Fastify instance `create()`
  returned, or the server it saw `listen()`. A worker still running after `gracefulShutdown.application` (10 s)
  is terminated.

## Answering Watt's checks

Every application already has an `ApplicationHealth`, `app.health`, so answering Watt is a mapping:

```ts
import type { Application } from '@caffeinejs/std'
import type { ProbeResult } from '@caffeinejs/std/health'
import { getGlobal, hasField, setCustomHealthCheck, setCustomReadinessCheck } from '@platformatic/globals'

interface WattCheckResult {
  status: boolean
  statusCode?: number
  body?: string
}

export function registerWattChecks(app: Application): void {
  if (!hasField('setCustomReadinessCheck') || !hasField('setCustomHealthCheck')) {
    if (getGlobal() !== undefined) {
      app.log.warn('Cannot register the Watt checks: they need Watt 3.56 or later')
    }

    return
  }

  const health = app.health

  setCustomReadinessCheck(async () => verdict('readyz', await health.readiness()))
  setCustomHealthCheck(async () => verdict('livez', await health.liveness()))
}

function verdict(probe: string, result: ProbeResult): WattCheckResult {
  return result.ok ? { status: true } : { status: false, statusCode: 503, body: `${probe} check failed` }
}
```

- **Register after `ready()` and before `run()`.** `app.health` fails until `ready()` has run, and until `run()`
  readiness refuses, so Watt never sees the application ready before it serves.
- **Guard with `hasField`.** The setters throw wherever the global lacks their field: outside Watt, and under a
  runtime older than 3.56, which registers its global without the fields they look up. The guard makes the same code
  a no-op under plain Node, and says so under an older Watt instead of serving with no checks. Reading
  `globalThis.platformatic` directly would reach those older runtimes too, but Platformatic calls that access
  deprecated.
- **Return an object for success too.** `async () => true` for a pass and an object for a failure is typed
  `Promise<true | {…}>`, which the setters' type does not accept. Watt reads `{ status: true }` exactly as it reads
  `true`.
- **Never throw, never pass `exclude`.** `ApplicationHealth` does not reject. An excluding call bypasses the cache
  and the coalescing, which are what keep Watt's uncached polling — every worker, on every `/ready` and every
  `/status` — off your dependencies.
- **Keep the body terse.** The probe server is public; `outcomes` name your dependencies.
- The checks share one evaluation with the `/readyz` that `.with(health())` serves, and the budgets set there
  apply to both. Keep `probeDeadline` (3 s by default) under Watt's `healthChecksTimeouts`.

## Starting an application

Watt loads the entry file named by `node.main` in the application's `watt.json`. If it exports `build` or
`create` — checked in that order, on the default export when there is one — Watt calls it and serves what it
returns: factory mode. Otherwise the module is expected to start itself: script mode.

|                        | Script mode                                                | Factory mode                                                                                 |
| ---------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| The entry              | runs `await app.run()`                                     | exports `create()`, returning `app.instance`                                                 |
| Who listens            | `run()`, with Watt choosing the entrypoint's host and port | Watt, on the entrypoint only; an internal application gets no port, and Watt injects into it |
| Marked started         | by `run()`                                                 | by you, before returning — `run()` never runs                                                |
| Same file outside Watt | starts as usual                                            | nothing calls `create()`                                                                     |

Use script mode for the entrypoint, so one entry file runs under Watt and under plain Node, and factory mode for
internal applications, which other applications reach through the runtime without a port.

### Script mode

```ts
const app = createWebApplication().with(health()).mount(routes)

await app.ready()
registerWattChecks(app)
await app.run()

export async function close(): Promise<void> {
  await app.close()
}
```

Watt takes over the `listen()` inside `run()` and binds the host and port its `server` block names. An internal
application in script mode listens on whatever port it asks for, and the runtime still reaches it in process.

### Factory mode

```ts
const app = createWebApplication()
  .mount(routes)
  .shutdown(s => s.drainDelay(0))

export async function create(): Promise<FastifyInstance> {
  await app.ready()
  registerWattChecks(app)
  app.availability.markStarted().acceptTraffic()

  return app.instance
}

export async function close(): Promise<void> {
  await app.close()
}
```

`markStarted().acceptTraffic()` is not optional. Without it the application stays "starting", readiness never
passes, and since `/status` fails with readiness, an orchestrator restarts the pod in a loop.

Do not export an unrelated `build` or `create`, and do not give the entry module a default export: Watt looks for
the factory on the default export when there is one.

### Headless workers

A worker with no HTTP server — a Kafka consumer, a scheduler — runs in script mode as a background application:
`"node": { "main": "…", "hasServer": false }` in its `watt.json`. Its checks are the only view Watt's probes have
of it.

```ts
const app = createApplication().shutdown(s => s.drainDelay(0))

await app.ready()
registerWattChecks(app)
await app.run()

export async function close(): Promise<void> {
  await app.close()
}
```

A headless application has no `health()` to tune its budgets with and runs on the defaults: 2 s per indicator, 3 s
per probe, results reused for 1 s. To change them, bind `kHealthRegistryOptions` from `@caffeinejs/std/health`
before `ready()`.

## Shutting down

`export async function close() { await app.close() }` is what runs Caffeine's shutdown under Watt: readiness
refuses, the drain delay passes, the server closes, and the container disposes, running every `OnDestroy` hook — a
Kafka consumer committing and leaving its group, a pool closing. Leave it out and Watt only closes the server:
none of that runs.

Watt then closes the Fastify instance or the server itself. That second close does nothing: Fastify runs its
close handlers once, and Watt skips a server that is no longer listening. `app.close()` is equally safe to reach
twice — a later call waits for the first and resolves.

- **Budgets.** Watt stops the entrypoint first, then the others, each within `gracefulShutdown.application`
  (10 s). The drain delay plus the teardown must fit in it; Caffeine's boot-time check measures them against the
  pod's grace period, which knows nothing of Watt's limit.
- **Drain only the entrypoint.** Watt's `/ready` fails the moment it receives `SIGTERM`, and the entrypoint's drain
  delay is what keeps it serving while the routing table catches up. Nothing outside routes to an internal or
  headless application, so a drain delay there only holds up the shutdown — and under Kubernetes the default is
  5 s for every application. Set `.shutdown(s => s.drainDelay(0))` on those, in code: under Kubernetes a drain delay
  of 0 that comes from the configuration draws a warning at boot, and one written in code does not.

## Kubernetes probes

- **Readiness:** Watt's `/ready`.
- **Liveness:** Watt's `/status` also fails while any application boots, drains or has a critical indicator down.
  Accept that — and prefer `critical: false` for dependencies every replica shares, or one outage restarts the
  fleet — or point the liveness probe at the entrypoint's `/livez` from `.with(health())`, which reports that
  application's liveness alone.
- **Startup:** Watt has no startup probe. Use `/ready` with a generous `failureThreshold`, or the entrypoint's
  `/startupz`.

## Building

Point `node.main` at compiled JavaScript. Watt hands a `.ts` entry to Node's type stripping, which leaves Caffeine's
`.js` import specifiers pointing at files that do not exist, and cannot run TC39 decorators at all.

## Base path

Watt hands an application the base path its own `watt.json` names, `"application": { "basePath": "/shop" }`, as
`/shop/`. A Watt gateway routes that prefix to the application; without one, the application serves it on the port it
already has. Read it with `getBasePath` from `@platformatic/globals`, which answers `undefined` outside Watt once told
not to throw. Its type also allows `null`, which `.basePath(...)` does not take:

```ts
const app = createWebApplication().basePath(() => getBasePath({ throwOnMissing: false }) ?? undefined)
```

`.basePath(...)` drops the trailing slash. The example's `web` is served under `/shop` this way. See
[Serving under a base path](../ai/docs/http.md#serving-under-a-base-path).

## What Caffeine is missing

What an application under Watt still writes by hand, or cannot do at all, and where each fix belongs. Unlike the
rest of this page, the Watt side of it was read from the 3.70.0 source rather than run.

### In Caffeine itself

A package on top cannot close these.

- **Starting without listening.** `run()` is the only step that marks an application started and accepting traffic,
  and `run()` listens. In factory mode Watt does the listening, so `create()` calls
  `app.availability.markStarted().acceptTraffic()` by hand, and an application that forgets never passes readiness.
  Missing: a step that does what `run()` does except listen, under the same rules: once, and never after `close()`.
- **Handing over the OpenAPI document.** `@caffeinejs/openapi` generates its document when the server is ready, and
  only serves it over HTTP. Giving it to Watt's `setOpenapiSchema`, so a Watt gateway can compose it, needs an
  accessor or an event. Today only `transformDocument` sees the document, and that hook is there to patch it.

### For a package on top

These need no change to Caffeine, only code that knows Watt: the next section.

- **Registering the checks.** `registerWattChecks` above, run for you.
- **The `create()` and `close()` exports**, for factory mode.
- **The drain delay.** 0 for every application but the entrypoint, which Watt's `isEntrypoint` tells apart.
- **The shutdown budget.** Watt gives each application `gracefulShutdown.application` (10 s) to stop in, a limit
  Caffeine's boot-time check does not know. Until something reads it, mirror it:
  `.shutdown(s => s.terminationGracePeriod('10s'))`, and the check clamps the teardown to fit.
- **The logger.** Watt wraps Caffeine's console output in log records of its own, at `info`, or at `error` from
  stderr, so the levels are lost. Watt's own logger is Pino, and a Pino logger is a Caffeine `Logger` as it is: until
  something does it for you, hand `getLogger()` from `@platformatic/globals` to `createApplication({ logger })`.
- **OpenTelemetry metrics.** `@caffeinejs/resilience` and `@caffeinejs/distlock` record on the global meter
  provider, which nothing in a Watt worker registers, so those metrics go nowhere. Watt takes OpenTelemetry metrics
  through `OpenTelemetryExporter` from `@platformatic/metrics`; wiring a meter provider to it is up to you.
- **Messaging between applications, and scheduled tasks.** Watt's `messaging` API and its cron exports, with
  handlers resolved from the container.

### Out of reach

- **TypeScript sources.** Node's type stripping cannot run TC39 decorators, and the `.js` specifiers need the
  compiled files. See [Building](#building).
- **`application.commands`.** An application started as a command runs as a child process, which has no custom
  checks and no messaging.
- **Why a worker stops.** Watt does not tell a worker whether it is shutting down or restarting, so an application
  cannot tell either.

### Works as is

- **Configuration.** An application's `env` in `watt.json` lands in its worker's `process.env`, which
  `EnvConfigSource` reads.
- **Health,** through `ApplicationHealth`, as above.
- **Calls between applications.** `fetch` and `@caffeinejs/brewer` reach `http://<id>.plt.local` in process.
- **Closing twice.** Watt's own close, after yours, does nothing.
- **The base path,** through `getBasePath`.

## A `@caffeinejs/platformatic` package

No such package exists. This is what one could offer, built on what Watt 3.70 hands every worker.

- **`.with(watt())`.** A feature whose bootstrap hook registers both checks from `ApplicationHealth` once the
  container has initialized. There is no ordering to get wrong, and outside Watt it does nothing.
- **An entry helper.** It builds the `create()` and `close()` exports: it readies the application, marks it started
  and hands Watt the Fastify instance. It would move onto Caffeine's own step for starting without listening, once
  there is one.
- **Settings read from Watt:**
  - a drain delay of 0 for every application but the entrypoint, from `isEntrypoint`, which Watt sets before the
    entry module loads;
  - the grace period from `runtimeConfig.gracefulShutdown.application`, and a check that `probeDeadline` fits
    `metrics.healthChecksTimeouts`;
  - the base path Watt assigned.
- **Wiring:**
  - Watt's Pino logger, which already carries the application and the worker;
  - Watt's Prometheus registry, bound in the container so a service registers its metrics by injection. Watt clears
    the registry when a worker stops or its metrics configuration changes, so the package has to register again;
  - a meter provider exporting through `OpenTelemetryExporter`, for Caffeine's OpenTelemetry instruments.
- **Messaging.** Watt's `messaging` — `send` with a reply and a 30 s default timeout, `notify` to every worker of an
  application, `handle` to answer — as handlers resolved from the container and an injectable client. It is request
  and reply with no delivery guarantee, so it fits a handler rather than a `@caffeinejs/messaging` binder, which
  relies on acknowledgement and retry.
- **Scheduled tasks.** Watt's cron exports, `scheduledTasks` and `tasks`, running tasks resolved from the container.
- **A capability of its own,** as the furthest step. Watt loads a third-party capability named by `"module"` in
  `watt.json`. A Caffeine one would take the application the entry module exports and do all of the above itself,
  so the entry would hold no Watt code at all. Two constraints: Watt loads a capability with `require()`, so nothing
  it imports may use top-level await, and `@platformatic/node`'s schema rejects unknown keys, so Caffeine's settings
  would need a schema of the capability's own.

How it would be built:

- on `@platformatic/globals`' getters with `{ throwOnMissing: false }`, so that under plain Node every part stands
  down;
- depending on `@caffeinejs/std` alone, with the HTTP parts behind a subpath, so a headless worker does not load
  Fastify;
- verified by running `examples/05-watt` under each Watt release it supports.
