import { Router } from '@caffeinejs/http'
import { Microsecond, Second, formatDuration, truncate } from '@caffeinejs/std/duration'

import { DevToolsAPI } from '../api.js'
import { kConfig } from '../app.config.js'
import { Badge, Icon, KeyValue, bytes, type IconName } from '../shared/components/index.js'
import { page } from '../shared/layout/index.js'

/** A share at or above it reads as high: the process is close to all it can use. */
const HIGH = 0.9

/** The process at the moment the page was asked for. */
export const runtimeRouter = new Router('/runtime')
  .inject({ api: DevToolsAPI, config: kConfig })
  .get('/', async (_ctx, { api, config }) => {
    const runtime = await api.runtime()
    const { userCPUTime, systemCPUTime } = runtime.resources
    // `process.resourceUsage()` counts CPU time in microseconds.
    const cpu = (userCPUTime + systemCPUTime) * Microsecond
    const heap = runtime.heap.used_heap_size
    const peak = runtime.resources.maxRSS * 1024
    const uptime = formatDuration(truncate(runtime.uptime, Second))

    return page(api, config, {
      title: 'Runtime',
      active: '/runtime',
      body: (
        <>
          <p class="lede" safe>{`Read when the page was asked for, up ${uptime}`}</p>
          <section class="usage-grid">
            <Usage
              label="CPU"
              icon="chip"
              share={share(cpu, runtime.uptime)}
              caption="Of one core, on average since start"
            />
            <Usage
              label="Event loop"
              icon="refresh"
              share={runtime.eventLoop.sincePrevious}
              caption={`Busy since the last read, ${percent(runtime.eventLoop.sinceStart)} since start`}
            />
            <Usage
              label="Heap"
              icon="layers"
              share={share(heap, runtime.heap.heap_size_limit)}
              caption={`${bytes(heap)} of the ${bytes(runtime.heap.heap_size_limit)} limit`}
            />
            {/* A process at its peak is not short of memory: this share never reads as high. */}
            <Usage
              label="Resident memory"
              icon="memory"
              share={share(runtime.memory.rss, peak)}
              caption={`${bytes(runtime.memory.rss)} of the ${bytes(peak)} peak`}
              warn={false}
            />
          </section>
          <section class="cards">
            <div class="card">
              <h2>Memory</h2>
              <KeyValue rows={Object.entries(runtime.memory).map(([key, value]) => [key, bytes(value)] as const)} />
            </div>
            <div class="card">
              <h2>Heap</h2>
              <KeyValue
                rows={[
                  ['used', bytes(heap)],
                  ['total', bytes(runtime.heap.total_heap_size)],
                  ['limit', bytes(runtime.heap.heap_size_limit)],
                ]}
              />
            </div>
            <div class="card">
              <h2>CPU</h2>
              <KeyValue
                rows={[
                  ['user', `${(userCPUTime / 1000).toFixed(0)} ms`],
                  ['system', `${(systemCPUTime / 1000).toFixed(0)} ms`],
                  ['max RSS', bytes(peak)],
                ]}
              />
            </div>
            <div class="card">
              <h2>Active resources</h2>
              <KeyValue rows={Object.entries(runtime.activeResources)} />
            </div>
          </section>
        </>
      ),
    })
  })

interface UsageProps {
  readonly label: string
  readonly icon: IconName
  /** From `0` to `1`; CPU time across several threads can pass `1`, and the meter stops there. */
  readonly share: number
  readonly caption: string
  /** Whether a share at {@link HIGH} or above is marked as high; it is unless this is `false`. */
  readonly warn?: boolean
}

/** A share as a box: its percentage, a meter, and what it is a share of. */
function Usage(props: UsageProps): JSX.Element {
  const high = props.warn !== false && props.share >= HIGH
  const filled = `${(Math.min(Math.max(props.share, 0), 1) * 100).toFixed(1)}%`

  return (
    <div class={high ? 'usage usage-high' : 'usage'}>
      <div class="usage-head">
        <Icon name={props.icon} />
        <span safe>{props.label}</span>
        {high ? <Badge tone="bad" text="high" /> : ''}
      </div>
      <p class="usage-value" safe>
        {percent(props.share)}
      </p>
      {/* Hidden from assistive technology: the percentage above says what the bar draws. */}
      <div class="meter" aria-hidden="true">
        <span style={`width: ${filled}`} />
      </div>
      <p class="usage-caption" safe>
        {props.caption}
      </p>
    </div>
  )
}

/** `part` as a share of `whole`, nothing of nothing. */
function share(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0
}

function percent(share: number): string {
  return `${(share * 100).toFixed(1)}%`
}
