import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { RuntimeRecord } from '@caffeinejs/devtools'
import { MiB } from '@caffeinejs/std/bytes'
import { Second } from '@caffeinejs/std/duration'
import { testClient } from '@caffeinejs/testing/http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { buildApp } from '../app.js'

/**
 * The runtime page over devtools that answer a reading chosen here: a live process never holds still long enough to
 * show a share near its limit, or past it.
 */

/** A process 10 s old, every share well under its limit. */
function reading(overrides: Partial<RuntimeRecord> = {}): RuntimeRecord {
  return {
    uptime: 10 * Second,
    memory: { rss: 120 * MiB, heapTotal: 64 * MiB, heapUsed: 40 * MiB, external: 4 * MiB, arrayBuffers: 1 * MiB },
    heap: { used_heap_size: 40 * MiB, total_heap_size: 64 * MiB, heap_size_limit: 1000 * MiB },
    // CPU time in microseconds, the maximum RSS in KiB, as Node reports them.
    resources: { userCPUTime: 2_000_000, systemCPUTime: 500_000, maxRSS: 160 * 1024 },
    eventLoop: { sinceStart: 0.1, sincePrevious: 0.2 },
    activeResources: { TCPSocketWrap: 2 },
    ...overrides,
  } as RuntimeRecord
}

/** Each usage box on the page, by its label. */
function boxesOf(page: string): Map<string, { high: boolean; value: string; filled: string; caption: string }> {
  const boxes = page.matchAll(
    /<div class="usage( usage-high)?">[\s\S]*?<span>([^<]+)<\/span>[\s\S]*?<p class="usage-value">([^<]+)<\/p>[\s\S]*?style="width: ([^"]+)"[\s\S]*?<p class="usage-caption">([^<]+)<\/p>/g,
  )

  return new Map(
    [...boxes].map(([, high, label, value, filled, caption]) => [
      label!,
      { high: high !== undefined, value: value!, filled: filled!, caption: caption! },
    ]),
  )
}

describe('runtime page', () => {
  let devtools: Server
  let answer: RuntimeRecord

  beforeAll(async () => {
    devtools = createServer((req, res) => {
      const body = req.url === '/devtools/runtime' ? answer : { tools: [] }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    })
    devtools.listen(0, '127.0.0.1')
    await once(devtools, 'listening')
    vi.stubEnv('CAFFEINE_DEVTOOLS_TARGET__URL', `http://127.0.0.1:${(devtools.address() as AddressInfo).port}/devtools`)
  })

  afterAll(() => {
    vi.unstubAllEnvs()
    devtools.close()
  })

  async function open(runtime: RuntimeRecord): Promise<string> {
    answer = runtime
    await using ui = testClient(buildApp({ logger: false }))
    const res = await ui.runtime.get()

    expect(res.status).toBe(200)
    return res.text()
  }

  async function boxes(runtime: RuntimeRecord) {
    return boxesOf(await open(runtime))
  }

  it('shows each share as a percentage and a meter: CPU time over uptime, the event loop, the heap of its limit', async () => {
    const shown = await boxes(reading())

    expect([...shown.keys()]).toEqual(['CPU', 'Event loop', 'Heap', 'Resident memory'])
    expect(shown.get('CPU')).toEqual({
      high: false,
      value: '25.0%',
      filled: '25.0%',
      caption: 'Of one core, on average since start',
    })
    expect(shown.get('Event loop')).toEqual({
      high: false,
      value: '20.0%',
      filled: '20.0%',
      caption: 'Busy since the last read, 10.0% since start',
    })
    expect(shown.get('Heap')).toEqual({
      high: false,
      value: '4.0%',
      filled: '4.0%',
      caption: '40.0 MiB of the 1000.0 MiB limit',
    })
    expect(shown.get('Resident memory')).toEqual({
      high: false,
      value: '75.0%',
      filled: '75.0%',
      caption: '120.0 MiB of the 160.0 MiB peak',
    })
  })

  it('marks a share near its limit as high, so a saturated process stands out', async () => {
    const shown = await boxes(
      reading({
        heap: { used_heap_size: 950 * MiB, total_heap_size: 980 * MiB, heap_size_limit: 1000 * MiB },
        eventLoop: { sinceStart: 0.5, sincePrevious: 0.9 },
      } as Partial<RuntimeRecord>),
    )

    expect(shown.get('Heap')).toMatchObject({ high: true, value: '95.0%' })
    expect(shown.get('Event loop')).toMatchObject({ high: true, value: '90.0%' })
    expect(shown.get('CPU')).toMatchObject({ high: false })
  })

  it('never marks resident memory as high: a process at its peak is not short of memory', async () => {
    const shown = await boxes(reading({ memory: { ...reading().memory, rss: 160 * MiB } } as Partial<RuntimeRecord>))

    expect(shown.get('Resident memory')).toMatchObject({ high: false, value: '100.0%', filled: '100.0%' })
  })

  it('fills the meter no further than full when threads together spend more than one core', async () => {
    // 15 s of CPU time in 10 s: one and a half cores.
    const shown = await boxes(
      reading({
        resources: { userCPUTime: 12_000_000, systemCPUTime: 3_000_000, maxRSS: 160 * 1024 },
      } as Partial<RuntimeRecord>),
    )

    expect(shown.get('CPU')).toMatchObject({ high: true, value: '150.0%', filled: '100.0%' })
  })

  it('says how long the process has been up, to the second', async () => {
    expect(await open(reading({ uptime: 75.5 * Second }))).toContain('Read when the page was asked for, up 1m15s')
  })

  it('shows no CPU for a process read in its first millisecond, rather than a share of nothing', async () => {
    const shown = await boxes(reading({ uptime: 0 }))

    expect(shown.get('CPU')).toMatchObject({ value: '0.0%', filled: '0.0%' })
  })
})
