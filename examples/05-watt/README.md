# Caffeine under Watt

Three Caffeine applications in one [Platformatic Watt](https://docs.platformatic.dev) runtime. Each is started
the way that suits it, and all of them answer Watt's health probes from their `ApplicationHealth`. The
walkthrough is [`docs/watt.md`](../../docs/watt.md).

| Application | Kind            | Start mode                                                                  |
| ----------- | --------------- | --------------------------------------------------------------------------- |
| `web`       | HTTP entrypoint | script — `main.ts` calls `run()`, and Watt takes over its `listen()`        |
| `orders`    | HTTP, internal  | factory — `create()` returns the Fastify instance, and Watt injects into it |
| `worker`    | headless        | script, with `node.hasServer: false` in its `watt.json`                     |

[`watt.ts`](watt.ts) is the part to copy: `registerWattChecks(app)` answers Watt's readiness and
liveness checks from the application's `ApplicationHealth`.

## Run

From the repository root:

```sh
make example:watt
```

That builds the framework packages and this example, then starts Watt on the compiled output: TypeScript sources do
not survive Node's type stripping, since their `.js` import specifiers point at files that do not exist. Stop it with
Ctrl+C, and every application closes in turn, the entrypoint first.

The target runs `wattpm` itself. `npm start` runs it too, and is what a container should run, where only npm receives
the signal. From a terminal, npm forwards Ctrl+C to Watt a second time, and Watt exits on a second signal without
closing its applications.

Then:

- `http://127.0.0.1:3042/shop/` is `web`, served under the base path its `watt.json` names, and `/shop/orders` goes
  through the runtime to the `orders` application.
- `http://127.0.0.1:9090/ready` and `/status` are Watt's probes, fed by every application's checks.
- `http://127.0.0.1:3042/shop/livez` is `web`'s own liveness, which ignores readiness.

`wattpm` runs the runtime and `@platformatic/node` each application. `@platformatic/globals` is Watt's typed API
for the rest: `watt.ts` registers the checks through it, as
[`docs/watt.md`](../../docs/watt.md#answering-watts-checks) explains, and `web` reads its base path with it.
