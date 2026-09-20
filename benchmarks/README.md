# Benchmarks

Private workspace. Nothing here is published.

## Running

```sh
make bench:<name>   # builds the framework and the fixtures, then runs
```

`make bench` lists the names. `npm run bench:<name> -w @caffeinejs/benchmarks` runs without building: it uses
whatever is in `dist/`, so after editing a fixture or a framework package, build first or the old code is what
gets measured.

Close everything else on the machine before a timing run, and do not run two benchmarks at once.

## What each one isolates

| Name                           | Measures                                                                    |
| ------------------------------ | --------------------------------------------------------------------------- |
| `helloworld`                   | Routing and serialization floor: one `GET` returning a small object         |
| `request`                      | A validated `POST`: params, query, body, headers, a hook, a response schema |
| `request:bun`                  | The `request` fixtures on Bun                                               |
| `mixedscopes`                  | `request` plus one request-scoped dependency                                |
| `authn`                        | JWT bearer verification and a role check                                    |
| `fastify`                      | The server alone against its fetch-style routing plugin                     |
| `startup`                      | Process start to listening, and bootstrap alone, for one six-module app     |
| `memory`                       | Heap held by that app once built, over an empty process                     |
| `testing`                      | Building an app, serving one request in-process, and closing it             |
| `di`, `di-compile`             | Container resolution and binding; `compile()` and boot at 200–2000 bindings |
| `di-compare`, `di-perf`        | Resolution against other containers                                         |
| `aspect`                       | A woven method call against a plain one                                     |
| `resilience`                   | Strategy overhead around a no-op operation                                  |
| `config-read`, `config-reload` | One configuration read on a request path; one reload of a 448-leaf tree     |

## Load benchmarks

`helloworld`, `request`, `request:bun`, `mixedscopes`, `authn` and `fastify` share `load-harness.ts`.

- Every server runs in its own process, under the Node binary running the harness, with `NODE_ENV=production`.
- Rounds are interleaved and rotated: each round runs every server once and starts one server later than the
  round before. The table reports the median round, with the minimum and maximum beside it. If two rows'
  ranges overlap, the run does not separate them.
- The load generator runs in worker threads, not on the harness thread.
- A run with any non-2xx response, connection error or timeout fails the benchmark.
- A port already in use fails the benchmark. The harness does not kill the process holding it.

| Variable            | Default          | Meaning                       |
| ------------------- | ---------------- | ----------------------------- |
| `BENCH_ROUNDS`      | `3`              | Rounds per server             |
| `BENCH_WARMUP`      | `5`              | Seconds of unmeasured load    |
| `BENCH_DURATION`    | `10`             | Seconds of measured load      |
| `BENCH_CONNECTIONS` | `100`            | Open connections              |
| `BENCH_PIPELINING`  | `10`             | Pipelined requests per socket |
| `BENCH_WORKERS`     | cores − 2, max 4 | Load generator threads        |

A fixture added to a load benchmark does the same work as its neighbours: the same validation, the same
response schema, the same hooks. `npm run test:fixtures -w @caffeinejs/benchmarks` checks that each one answers
correctly; CI runs it before any benchmark.

## Microbenchmarks

These use mitata and run with `--expose-gc`.

- Consume every result with `do_not_optimize`, or V8 can drop the call. mitata marks a case it suspects was
  eliminated with `!`.
- Keep state out of the timed region and bounded across iterations: a container or counter that grows per
  iteration makes every later case depend on the ones before it.
- Compare within a `summary()` group only. Cases in different groups measure different things.

## CI

`.github/workflows/bench.yml` runs one benchmark on demand. Runners are shared: compare rows within a run, not
numbers across runs.
