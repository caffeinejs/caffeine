# fetchy benchmarks

Compares `@caffeinejs/fetchy` against other HTTP clients (`fetch`, `axios`,
`got`, `undici`, `fetchy-undici`, `heyapi`, `orval`) issuing the same
`POST /{id}?filter=...` request with a JSON body against a fixed local
server.

```bash
npm run bench -w @caffeinejs/fetchy
```

Spawns the benchmark server, runs every client through
[mitata](https://github.com/evanwashere/mitata), prints results, and tears
the server down — no separate steps needed.

Env: `PORT` (default `3100`), `CONCURRENCY` (default `100`).

## Adding a library

1. Add it as a devDependency in `fetchy/package.json`.
2. Create `clients/<lib>.ts` exporting a `BenchClient` (see `clients/bench_client.ts`):
   ```ts
   export const myClient: BenchClient = {
     name: 'my-lib',
     request: () => /* one request, same shape as config.ts's benchBody/benchPath */,
   }
   ```
3. Add it to the `clients` array in `clients/index.ts`.

`post.bench.ts` needs no changes.

## Hey API and Orval (codegen'd clients)

Unlike every other entry, `heyapi` and `orval` are generated from
`openapi.yaml` (the single benchmarked endpoint) rather than hand-written.
The generated output under `generated/heyapi/` and `generated/orval/` is
committed to git, not regenerated on every bench run.

If `openapi.yaml` changes, regenerate and commit the new output:

```bash
npm run bench:generate -w @caffeinejs/fetchy
```

Orval is configured for `client: 'fetch'` mode (not its default axios) via
`orval.config.mjs`, dispatching through `custom_fetch.ts` so the generated
client picks up the same `baseURL` as every other client (Orval's fetch
client otherwise only knows relative paths). Hey API's generated client
gets the same `baseURL` applied at runtime via `client.setConfig(...)` in
`clients/heyapi.ts`.
