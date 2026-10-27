import type { getHeapStatistics } from 'node:v8'

import { $t, type InferSchema } from '@caffeinejs/application/schema'

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
