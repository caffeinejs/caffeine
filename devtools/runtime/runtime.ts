import { performance, type EventLoopUtilization } from 'node:perf_hooks'
import { getHeapStatistics } from 'node:v8'

import { $t, type InferSchema } from '@caffeinejs/application/schema'
import { Router } from '@caffeinejs/http'
import { Second } from '@caffeinejs/std/duration'

import type { ToolInfo } from '../tool.js'

/** A table of numbers under the names Node gives them, typed as Node types it. */
function counters<T>() {
  return $t.Unsafe<T>($t.Record($t.String(), $t.Number()))
}

/** The process at the moment it was read. */
export const RuntimeSchema = $t.Object({
  /** A duration, in milliseconds. */
  uptime: $t.Number(),
  /** `process.memoryUsage()`, in bytes. */
  memory: counters<NodeJS.MemoryUsage>(),
  /** What `v8.getHeapStatistics()` reports, in bytes. */
  heap: counters<ReturnType<typeof getHeapStatistics>>(),
  /** `process.resourceUsage()`: CPU time in microseconds, as Node reports it. */
  resources: counters<NodeJS.ResourceUsage>(),
  /** The share of time the event loop was busy, from `0` to `1`. */
  eventLoop: $t.Object({
    /** Since the process started. */
    sinceStart: $t.Number(),
    /** Since the previous read of this tool, or since it attached for the first read. */
    sincePrevious: $t.Number(),
  }),
  /** The handles and requests keeping the event loop alive, counted by type: `TCPSocketWrap`, `Timeout`. */
  activeResources: $t.Record($t.String(), $t.Number()),
})

export type RuntimeRecord = InferSchema<typeof RuntimeSchema>

export const runtimeTool: ToolInfo = {
  id: 'runtime',
  title: 'Runtime',
  description: 'Memory, heap, CPU and how busy the event loop is, read when asked',
}

/** Reads the process: memory, heap, CPU and how busy the event loop is. */
export class RuntimeTool {
  #previous: EventLoopUtilization = performance.eventLoopUtilization()

  read(): RuntimeRecord {
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

/**
 * The process at the moment it is read.
 *
 * - `GET /runtime`
 */
export function runtimeRouter(tool: RuntimeTool) {
  return new Router('/runtime')
    .get('')
    .schema({ response: { 200: RuntimeSchema } })
    .handler(() => tool.read())
}
