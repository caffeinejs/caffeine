import { performance, type EventLoopUtilization } from 'node:perf_hooks'
import { getHeapStatistics } from 'node:v8'

import { DevTool, type DevToolOperation } from '@caffeinejs/application/devtools'
import { Second, type Duration } from '@caffeinejs/std/duration'

/** The process at the moment it was read. */
export interface RuntimeRecord {
  readonly uptime: Duration
  /** `process.memoryUsage()`, in bytes. */
  readonly memory: NodeJS.MemoryUsage
  /** What `v8.getHeapStatistics()` reports, in bytes. */
  readonly heap: ReturnType<typeof getHeapStatistics>
  /** `process.resourceUsage()`: CPU time in microseconds, as Node reports it. */
  readonly resources: NodeJS.ResourceUsage
  /** The share of time the event loop was busy, from `0` to `1`. */
  readonly eventLoop: {
    /** Since the process started. */
    readonly sinceStart: number
    /** Since the previous read of this tool, or since it attached for the first read. */
    readonly sincePrevious: number
  }
  /** The handles and requests keeping the event loop alive, counted by type: `TCPSocketWrap`, `Timeout`. */
  readonly activeResources: Readonly<Record<string, number>>
}

/**
 * The process at the moment it is read: memory, heap, CPU and how busy the event loop is.
 *
 * - `GET /runtime`
 */
export class RuntimeTool extends DevTool {
  readonly id = 'runtime'
  readonly title = 'Runtime'
  readonly description = 'Memory, heap, CPU and how busy the event loop is, read when asked'
  readonly operations: readonly DevToolOperation[]

  #previous: EventLoopUtilization = performance.eventLoopUtilization()

  constructor() {
    super()
    this.operations = [{ method: 'GET', path: '', handle: () => this.#read() }]
  }

  #read(): RuntimeRecord {
    const now = performance.eventLoopUtilization()
    const sincePrevious = performance.eventLoopUtilization(now, this.#previous).utilization
    this.#previous = now

    const activeResources: Record<string, number> = {}
    for (const type of process.getActiveResourcesInfo()) {
      activeResources[type] = (activeResources[type] ?? 0) + 1
    }

    return {
      uptime: Math.floor(process.uptime() * Second),
      memory: process.memoryUsage(),
      heap: getHeapStatistics(),
      resources: process.resourceUsage(),
      eventLoop: { sinceStart: now.utilization, sincePrevious },
      activeResources,
    }
  }
}
