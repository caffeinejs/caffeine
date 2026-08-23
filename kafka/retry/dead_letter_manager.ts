import type { KafkaMessage } from '../config.js'
import { wrapDeserializers } from '../deser.js'
import type { KafkaRuntime } from '../runtime.js'
import { RetryHeaders } from '../symbols.js'
import type { KafkaTemplate } from '../template.js'

/** A record read back from a dead-letter topic, with any exception metadata carried in its headers. */
export interface DeadLetterRecord {
  topic: string
  partition: number
  offset: bigint
  key?: string
  value: unknown
  headers: Map<string, string>
  /** Exception class/message parsed from the `x-exception-*` headers stamped at recovery time. */
  error?: { class?: string, message?: string }
}

/**
 * Uber's reliable-reprocessing loop, as a pluggable surface: inspect the dead-letter topic, purge it, or
 * re-inject its records back into the retry chain once the underlying bug is fixed. Bound per instance; override
 * the builtin with `app.kafka(k => k.deadLetterManager(...))`.
 */
export interface DeadLetterManager {
  /** Reads (peeks) up to `limit` records from a dead-letter topic without committing — for diagnosis. */
  list(dltTopic: string, opts?: { limit?: number }): Promise<DeadLetterRecord[]>
  /** Deletes and recreates the dead-letter topic, dropping its backlog. Returns the number of records drained. */
  purge(dltTopic: string): Promise<number>
  /** Re-publishes records back into the retry chain (default `${original}-retry-0`). Returns the count. */
  reprocess(dltTopic: string, opts?: { to?: string, limit?: number }): Promise<number>
}

/** Tuning for the builtin {@link deadLetterManager}. */
export interface DeadLetterManagerOptions {
  /** Idle window (ms) with no new record before a drain stops. Default `500`. */
  idleTimeout?: number
}

const IDLE = Symbol('idle')

/**
 * The builtin {@link DeadLetterManager}: drains a dead-letter topic through a transient consumer (fresh group,
 * no commit, stops after an idle window), re-injecting via the instance's {@link KafkaTemplate} and purging via
 * the `Admin` client. Works on a real broker and the in-memory test broker alike.
 */
export function deadLetterManager(
  runtime: KafkaRuntime,
  template: KafkaTemplate,
  options: DeadLetterManagerOptions = {},
): DeadLetterManager {
  const idleTimeout = options.idleTimeout ?? 500

  // Reads a topic to (idle) exhaustion through a throwaway consumer, invoking `onEach`. Never commits.
  async function drain(
    topic: string,
    limit: number | undefined,
    onEach: (message: KafkaMessage) => void | Promise<void>,
  ): Promise<number> {
    const groupId = `${runtime.name}-dlq-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const consumer = runtime.clients.createConsumer(runtime.config, groupId)
    const stream = await consumer.consume({
      topics: [topic],
      autocommit: false,
      deserializers: wrapDeserializers(runtime.config.deserializers),
    })

    let count = 0
    try {
      const iterator = stream[Symbol.asyncIterator]()
      while (limit === undefined || count < limit) {
        const idle = new Promise<typeof IDLE>(resolve => setTimeout(() => resolve(IDLE), idleTimeout))
        const next = await Promise.race([iterator.next(), idle])
        if (next === IDLE || next.done) {
          break
        }
        await onEach(next.value)
        count++
      }
    } finally {
      await stream.close()
      await consumer.close()
    }
    return count
  }

  return {
    async list(dltTopic: string, opts): Promise<DeadLetterRecord[]> {
      const records: DeadLetterRecord[] = []
      await drain(dltTopic, opts?.limit, message => {
        records.push(toRecord(message))
      })
      return records
    },

    async reprocess(dltTopic: string, opts): Promise<number> {
      return drain(dltTopic, opts?.limit, async message => {
        const original = message.headers.get(RetryHeaders.ORIGINAL_TOPIC) ?? stripDlt(dltTopic)
        const target = opts?.to ?? `${original}-retry-0`
        const headers: Record<string, string> = {
          [RetryHeaders.ORIGINAL_TOPIC]: original,
          [RetryHeaders.ATTEMPT]: '1',
          'x-reprocessed-at': String(Date.now()),
        }
        await template.sendMessage({ topic: target, key: message.key, value: message.value, headers })
      })
    },

    async purge(dltTopic: string): Promise<number> {
      const drained = await drain(dltTopic, undefined, () => undefined)
      const admin = runtime.clients.createAdmin?.(runtime.config)
      if (admin !== undefined) {
        const { partitions, replicas } = runtime.config.topicProvisioning
        try {
          // Preserve the topic's existing partitioning across the purge (fall back to config/1).
          const existing = (await admin.partitionCounts?.([dltTopic]))?.get(dltTopic)
          await admin.deleteTopics([dltTopic])
          await admin.createTopics([{ topic: dltTopic, partitions: existing ?? partitions ?? 1, replicas }])
        } finally {
          await admin.close()
        }
      }
      return drained
    },
  }
}

function toRecord(message: KafkaMessage): DeadLetterRecord {
  const errorClass = message.headers.get('x-exception-class')
  const errorMessage = message.headers.get('x-exception-message')
  return {
    topic: message.topic,
    partition: message.partition,
    offset: message.offset,
    key: message.key,
    value: message.value,
    headers: message.headers,
    error: errorClass !== undefined || errorMessage !== undefined
      ? { class: errorClass, message: errorMessage }
      : undefined,
  }
}

// Best-effort recovery of the source topic from a `${source}.DLT` name when the header is absent.
function stripDlt(dltTopic: string): string {
  return dltTopic.endsWith('.DLT') ? dltTopic.slice(0, -'.DLT'.length) : dltTopic
}
