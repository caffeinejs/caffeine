import autocannon from 'autocannon'

import type { AdRequest } from '../src/auction/auction.schemas.js'
import type { DSPStatus, Outcome } from '../src/dsps/dsp.schemas.js'

/**
 * Puts the running exchange under the load of a busy ad server, then checks what a production exchange must hold to:
 * the slowest auctions still answer inside the ad server's own timeout, none fails, and nearly every one sells.
 *
 * Run it against `docker compose up` or `npm start` with the DSPs up. `BASELINE=1` reports the same numbers without
 * failing, for the exchange started with the `bare` profile, which calls the DSPs with no policy at all.
 *
 * LOAD_URL (http://127.0.0.1:9500), LOAD_RATE (1000 auctions a second), LOAD_CONNECTIONS (64), LOAD_WARMUP and
 * LOAD_DURATION (10 and 30 seconds) change the run. The warmup outlasts a breaker's 5s open state, so one that opened
 * while the exchange was cold has closed again before the measured run starts.
 */

const origin = process.env.LOAD_URL ?? 'http://127.0.0.1:9500'
const connections = Number(process.env.LOAD_CONNECTIONS ?? 64)
const rate = Number(process.env.LOAD_RATE ?? 1000)
const warmup = Number(process.env.LOAD_WARMUP ?? 10)
const duration = Number(process.env.LOAD_DURATION ?? 30)
const baseline = process.env.BASELINE === '1'

/** What the run must hold to, unless it is the baseline. */
const BUDGET = {
  /** An ad server waits about 100ms for its exchange; the 80ms DSP deadline leaves the rest for the exchange itself. */
  p99: 100,
  /** The share of auctions that sell. Every well-behaved DSP bids most auctions, so a lower one means lost bids. */
  fill: 0.95,
  /** The share of the dead DSP's auctions its open breaker refuses without calling it. */
  deadRefused: 0.9,
} as const

const SIZES = [
  [300, 250],
  [728, 90],
  [160, 600],
  [320, 50],
] as const

function adRequest(n: number): AdRequest {
  const [w, h] = SIZES[n % SIZES.length] ?? SIZES[0]
  return {
    slot: { id: `slot-${n % 16}`, w, h },
    floor: Math.round((0.5 + Math.random()) * 100) / 100,
    site: { domain: `site-${n % 32}.test` },
    user: { id: `user-${n % 1024}` },
  }
}

function run(seconds: number): Promise<autocannon.Result> {
  let n = 0
  return autocannon({
    url: `${origin}/ad`,
    connections,
    duration: seconds,
    // A steady rate, as an ad server's traffic is, rather than as fast as the exchange answers: an exchange that
    // stopped calling its DSPs would answer fastest of all.
    overallRate: rate,
    // An ad server gives up on an exchange after a second at most; the baseline shows how many it would lose.
    timeout: 1,
    requests: [
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        setupRequest: request => ({ ...request, body: JSON.stringify(adRequest(n++)) }),
      },
    ],
  })
}

async function dsps(): Promise<DSPStatus[]> {
  const res = await fetch(`${origin}/dsps`)
  if (!res.ok) {
    throw new Error(`Cannot read the DSPs: GET ${origin}/dsps answered ${res.status}`)
  }
  return ((await res.json()) as { dsps: DSPStatus[] }).dsps
}

/** Each DSP's outcomes over the measured run alone: the counts at its end less those at its start. */
function delta(before: DSPStatus[], after: DSPStatus[]): Map<string, Record<Outcome, number>> {
  return new Map(
    after.map(dsp => {
      const start = before.find(b => b.id === dsp.id)?.outcomes
      const outcomes = Object.fromEntries(
        Object.entries(dsp.outcomes).map(([outcome, count]) => [outcome, count - (start?.[outcome as Outcome] ?? 0)]),
      ) as Record<Outcome, number>
      return [dsp.id, outcomes]
    }),
  )
}

function percent(share: number): string {
  return `${(share * 100).toFixed(1)}%`
}

console.log(
  `Warming up for ${warmup}s, then ${duration}s of ${rate} auctions a second on ${connections} connections, at ${origin}`,
)
await run(warmup)
const before = await dsps()
const result = await run(duration)
const after = await dsps()

const total = result.requests.total + result.timeouts
const sold = result.statusCodeStats?.['200']?.count ?? 0
const fill = total === 0 ? 0 : sold / total
const outcomes = delta(before, after)

console.log()
console.log(`Auctions:   ${result.requests.total} answered, ${Math.round(result.requests.average)}/s`)
console.log(
  `Latency:    p50 ${result.latency.p50}ms, p90 ${result.latency.p90}ms, p99 ${result.latency.p99}ms, max ${result.latency.max}ms`,
)
console.log(`Sold:       ${percent(fill)} (${sold}), the rest unsold (204)`)
console.log(`Failures:   ${result.non2xx} non-2xx, ${result.errors} errors, ${result.timeouts} timeouts`)
console.log()
console.table(
  after.map(dsp => ({
    dsp: dsp.id,
    state: dsp.state,
    ...outcomes.get(dsp.id),
  })),
)

if (baseline) {
  process.exit(0)
}

const dead = outcomes.get('dsp-dead')
const deadTotal = dead === undefined ? 0 : Object.values(dead).reduce((sum, count) => sum + count, 0)
const deadRefused = deadTotal === 0 ? 0 : (dead?.circuit_open ?? 0) / deadTotal

const failed = [
  result.latency.p99 > BUDGET.p99 && `p99 is ${result.latency.p99}ms, over the ${BUDGET.p99}ms budget`,
  result.non2xx > 0 && `${result.non2xx} auctions answered with a status other than 200 or 204`,
  result.errors > 0 && `${result.errors} requests failed`,
  fill < BUDGET.fill && `${percent(fill)} of the auctions sold, under the ${percent(BUDGET.fill)} budget`,
  deadRefused < BUDGET.deadRefused &&
    `the dead DSP's breaker refused ${percent(deadRefused)} of its auctions, under ${percent(BUDGET.deadRefused)}`,
].filter(reason => reason !== false)

if (failed.length > 0) {
  console.error(`\nFAIL\n${failed.map(reason => `  - ${reason}`).join('\n')}`)
  process.exit(1)
}
console.log(`\nPASS: p99 ${result.latency.p99}ms, ${percent(fill)} sold, dead DSP refused ${percent(deadRefused)}`)
