import { performance, type EventLoopUtilization } from 'node:perf_hooks'
import { getHeapStatistics } from 'node:v8'

import { Second } from '@caffeinejs/std/duration'

import type { ToolInfo } from '../tool.js'
import type { RuntimeRecord } from './runtime.schema.js'

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
