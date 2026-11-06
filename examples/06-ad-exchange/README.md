# 06 — Ad exchange (resilience under load)

An ad exchange: an ad server sends it an ad request, it offers the slot to eight DSPs at once, and it sells the slot to
the highest bid at or above the publisher's floor, all inside the ad server's own timeout. Three of the DSPs misbehave,
and `@caffeinejs/resilience` is what keeps them from costing the other auctions:

- **A deadline** for every bid request (the time limiter, 80ms, sent to each DSP as `tmax`): an answer later than that
  is not waited for, and its request is closed.
- **A circuit breaker** per DSP: one that keeps failing or timing out is not called at all for 5 seconds, then tried
  again with a few calls.
- **A bulkhead** per DSP: at most 64 bid requests in flight to one DSP, the rest refused at once.
- **A rate limiter** for a DSP that agreed to a number of requests a second (`qps`).
- **A fallback** that turns each refusal into a reason for no bid, so a failing DSP is a missing bid, never a failed
  auction.
- **A retry** for the win notice, sent to the winner after the answer, with `@Resilient('win-notice')`.

The DSPs are [VLatte](https://vlatte.dev) mock servers, one per directory under [`dsps/`](dsps), in Docker Compose.
A load script made with [autocannon](https://github.com/mcollina/autocannon) checks that the exchange stays fast
while they misbehave, and shows what happens to the same exchange without any policy.

## The DSPs

| DSP           | Port (admin) | What it does                                                                                    |
| ------------- | ------------ | ----------------------------------------------------------------------------------------------- |
| `dsp-alpha`   | 8101 (8201)  | Bids 8 auctions of 10 in about 15ms.                                                            |
| `dsp-bravo`   | 8102 (8202)  | Bids 7 of 10 in about 20ms.                                                                     |
| `dsp-charlie` | 8103 (8203)  | Bids 6 of 10 in about 25ms.                                                                     |
| `dsp-delta`   | 8104 (8204)  | Bids every other auction, high, in 20ms to 40ms.                                                |
| `dsp-echo`    | 8105 (8205)  | Bids 9 of 10 in about 10ms, low, and agreed to 500 requests a second (`qps: 500`).              |
| `dsp-dead`    | 8106 (8206)  | Accepts the connection, reads the request, and never answers.                                   |
| `dsp-slow`    | 8107 (8207)  | Bids every auction, high, on a long tail: half its answers take over 70ms, some take seconds.   |
| `dsp-flaky`   | 8108 (8208)  | Fails half its requests: resets the connection, answers 500, sends garbage, or closes silently. |

`dsp-flaky` picks its failure from the first hex digit of the auction id, so each kind is a sixteenth or more of its
traffic. `dsp-dead` has a mock that answers, off at start; turn it on while the load runs and watch its breaker close:

```bash
curl -X PATCH localhost:8206/mocks/alive -H 'content-type: application/json' -d '{"enabled": true}'
```

## Architecture

```text
src/main.ts                       bootstrap: builds the container from the generated graph and runs the app
src/app.ts                        the wiring: Resilience(), one preset per DSP, healthProbes(), shutdown
src/app.config.ts                 the configuration schema and its token
src/auction/auction.controller.ts POST /ad: runs the auction, answers 200 with the winner or 204, sends the win notice
src/auction/auctioneer.ts         fans the bid request out to every DSP and picks the winner
src/dsps/dsp.api.ts               the fetchy API a DSP answers: POST /bid and POST /win
src/dsps/dsp.fleet.ts             one fetchy client and one guarded bid per DSP, and the outcome counts
src/dsps/dsps.controller.ts       GET /dsps: each DSP's breaker, bulkhead, rate limiter and outcomes
src/wins/win.notifier.ts          the win notice, @Resilient('win-notice')
src/util/testing/                 fake DSPs on real sockets, and the exchange the tests start
dsps/<name>/bid_mock.yaml         each VLatte DSP's mocks
load/load.ts                      the load script
```

The DSPs are listed in the configuration, so their policies cannot be annotations: [`src/dsps/dsp.fleet.ts`](src/dsps/dsp.fleet.ts)
composes each DSP's chain from the `ResilienceRegistry`, in the order the annotations use:

```ts
// The rate limiter only for a DSP with a `qps`.
compose(
  noBid,
  registry.circuitBreaker(id),
  registry.rateLimiter(id),
  registry.timeLimiter(id),
  registry.bulkhead(id),
)(call)
```

[`src/app.ts`](src/app.ts) names the policies each DSP has, a preset named after its id; the options come from
`resilience.defaults` in [`config/application.yaml`](config/application.yaml), and `resilience.presets.<id>` changes
one DSP's.

## Run it

With the DSPs in Docker and the exchange on the host:

```bash
make example:ad-exchange        # 8 DSPs in Docker, exchange at http://127.0.0.1:9500
```

Or all of it in Docker, from this directory:

```bash
docker compose up --build
```

Then:

```bash
curl -s -X POST localhost:9500/ad -H 'content-type: application/json' \
  -d '{"slot": {"id": "s-1", "w": 300, "h": 250}, "floor": 1, "site": {"domain": "news.test"}}'
curl -s localhost:9500/dsps
```

`POST /ad` answers 200 with the auction id, the winner, its price and its markup, or 204 when no bid reached the floor.
It never answers a 5xx for a DSP's failure.

## Load test

With the exchange running:

```bash
make example:ad-exchange-load
```

It warms up for 10 seconds, longer than a breaker stays open, then sends 1000 auctions a second for 30 seconds on 64
connections, prints the latency, the share of auctions sold, and what became of each DSP's bid requests, and fails
when:

- p99 is over 100ms, about what an ad server waits for its exchange;
- any auction failed, answered a status other than 200 or 204, or timed out;
- fewer than 95% of the auctions sold;
- the dead DSP's breaker refused fewer than 90% of its auctions.

`LOAD_URL`, `LOAD_RATE`, `LOAD_CONNECTIONS`, `LOAD_WARMUP` and `LOAD_DURATION` change the run.

On a 4-core Linux machine running the exchange, the eight DSPs and autocannon at once, it measured p50 24ms, p90 50ms,
p99 about 80ms, 96.8% of the auctions sold, and 99.9% of the dead DSP's auctions refused by its breaker. Your numbers
depend on your machine; Docker Desktop's network adds to every bid request.

### Without resilience

The `bare` profile calls every DSP with no policy at all. Start the exchange with it and run the load as a baseline,
which reports without failing:

```bash
CAFFEINE_PROFILES=docker,bare docker compose up --build   # or, with the DSPs of `make example:ad-exchange`: CAFFEINE_PROFILES=bare npm start
BASELINE=1 make example:ad-exchange-load
```

Every auction waits for the dead DSP. On the same machine, none of 901 auctions was answered within the second the
load script waits, and the 64 connections stayed busy waiting.

## Configuration

One YAML file per profile, under [`config/`](config):

| Profile  | What it changes                                                                                                 |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| none     | Exchange on `127.0.0.1:9500`, DSPs on `127.0.0.1:8101` to `8108`, resilience on.                                |
| `docker` | Listens on every interface, calls each DSP by its compose service name.                                         |
| `bare`   | `exchange.resilience: false`: the baseline.                                                                     |
| `test`   | An OS-assigned port, windows small enough that each policy trips within a few calls, and an hour-long deadline. |

`CAFFEINE_PROFILES` picks them, as in `CAFFEINE_PROFILES=docker,bare`.

## Tests

```bash
npm test -w @caffeinejs/example-ad-exchange
```

The tests start the whole application on a real socket, against fake DSPs that answer as each test scripts them: a
bid, a 500, a reset, garbage, or nothing until released. They cover the auction, each policy, the win notice and each
profile.

## Out of scope

- One impression per request, one bid per answer, first-price: no OpenRTB beyond the field names, no second-price
  auction, no deals, no currency.
- The win notice is fire-and-forget: a notice still retrying when the exchange stops is lost.
