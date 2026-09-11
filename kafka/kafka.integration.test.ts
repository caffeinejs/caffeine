import { connect } from 'node:net'

import { createApplication } from '@caffeinejs/std'
import { Admin } from '@platformatic/kafka'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { KafkaMessage } from './config.js'
import { KafkaHandler } from './decorators/kafka_handler.js'
import { KafkaListener } from './decorators/kafka_listener.js'
import { KafkaParams } from './decorators/kafka_params.js'
import { KafkaRetry } from './decorators/kafka_retry.js'
import { kafka } from './plugin.js'
import { retryTopics } from './retry/strategy.js'
import { KafkaTemplate } from './template.js'

interface Delivered {
  value: unknown
  key: string
  message: KafkaMessage
}

const RETRY_TOPIC = 'caffeine-kafka-it-retry'

class ErrBoom extends Error {
  override name = 'ErrBoom'
}

// Fails a fixed number of times per delivery, then succeeds — proves in-process retry over a real broker.
let retryState!: { attempts: number; done: { promise: Promise<number>; resolve: (n: number) => void } }
function resetRetry(): void {
  let resolve!: (n: number) => void
  const promise = new Promise<number>(res => {
    resolve = res
  })
  retryState = { attempts: 0, done: { promise, resolve } }
}
resetRetry()

@KafkaHandler()
class RetryingConsumer {
  @KafkaListener({ topic: RETRY_TOPIC })
  @KafkaRetry({ attempts: 3, backoff: { type: 'fixed', delay: 100 } })
  onEvent(): void {
    retryState.attempts++
    if (retryState.attempts < 3) {
      throw new ErrBoom(`attempt ${retryState.attempts}`)
    }
    retryState.done.resolve(retryState.attempts)
  }
}

const RETRY_TOPICS_TOPIC = 'caffeine-kafka-it-rt'

// Fails twice then succeeds, but through non-blocking retry TOPICS (the record traverses -retry-0/-retry-1).
let rtState!: { attempts: number; done: { promise: Promise<number>; resolve: (n: number) => void } }
function resetRt(): void {
  let resolve!: (n: number) => void
  const promise = new Promise<number>(res => {
    resolve = res
  })
  rtState = { attempts: 0, done: { promise, resolve } }
}
resetRt()

@KafkaHandler()
class RetryTopicsConsumer {
  @KafkaListener({ topic: RETRY_TOPICS_TOPIC })
  @KafkaRetry(retryTopics({ attempts: 3, backoff: { type: 'fixed', delay: 200 } }))
  onEvent(): void {
    rtState.attempts++
    if (rtState.attempts < 3) {
      throw new ErrBoom(`rt attempt ${rtState.attempts}`)
    }
    rtState.done.resolve(rtState.attempts)
  }
}

const BROKER = process.env.KAFKA_BROKER ?? 'localhost:9092'
const TOPIC = 'caffeine-kafka-it'

/** True when a TCP connection to the broker succeeds; specs skip when it is not reachable (offline/CI). */
async function brokerUp(): Promise<boolean> {
  const [host, portStr] = BROKER.split(':')
  const port = Number(portStr ?? 9092)

  return new Promise<boolean>(resolve => {
    const socket = connect({ host, port })
    const done = (up: boolean): void => {
      socket.destroy()
      resolve(up)
    }
    socket.setTimeout(2000)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

// A handler capturing the next delivery on the integration topic into a resolvable promise. Uses @KafkaParams
// to prove argument extraction (value + key) works over a real broker, while still keeping the raw message.
let received!: { promise: Promise<Delivered>; resolve: (d: Delivered) => void }
function resetReceived(): void {
  let resolve!: (d: Delivered) => void
  const promise = new Promise<Delivered>(res => {
    resolve = res
  })
  received = { promise, resolve }
}
resetReceived()

@KafkaHandler()
class IntegrationConsumer {
  @KafkaListener({ topic: TOPIC })
  @KafkaParams(k => [k.value(), k.key(), k.message()])
  onMessage(value: unknown, key: string, message: KafkaMessage): void {
    received.resolve({ value, key, message })
  }
}

const up = await brokerUp()

describe.skipIf(!up)('kafka integration (real broker)', () => {
  const app = createApplication({}).extend(
    kafka(k =>
      k
        .brokers(BROKER)
        .clientId('caffeine-kafka-it')
        // Fresh group per run so the consumer reads messages produced after it joins.
        .groupId(`caffeine-kafka-it-${Date.now()}`),
    ),
  )
  const built = app.build()

  beforeAll(async () => {
    // Ensure the topic exists — the producer does not rely on broker-side auto-creation.
    const admin = new Admin({ clientId: 'caffeine-kafka-it-admin', bootstrapBrokers: [BROKER] })
    try {
      await admin.createTopics({ topics: [TOPIC, RETRY_TOPIC], partitions: 1, replicas: 1 })
    } catch {
      // Topic already exists — fine.
    }
    try {
      // The retry-topics source has 3 partitions; its retry topics should inherit that count.
      await admin.createTopics({ topics: [RETRY_TOPICS_TOPIC], partitions: 3, replicas: 1 })
    } catch {
      // Topic already exists — fine.
    } finally {
      await admin.close()
    }
  })

  afterAll(async () => {
    await built.close()
  })

  it('delivers a produced message to a @KafkaListener over a real broker', async () => {
    resetReceived()
    await built.run()

    const template = built.container.get<KafkaTemplate>(KafkaTemplate)
    const payload = { hello: 'kafka', at: Date.now() }

    // Resend until the consumer group has joined and the message is delivered (or the test times out).
    const deadline = Date.now() + 20_000
    let delivered: Delivered | undefined
    while (delivered === undefined && Date.now() < deadline) {
      await template.send(TOPIC, payload, { key: 'k1' })
      delivered = await Promise.race([
        received.promise,
        new Promise<undefined>(res => setTimeout(() => res(undefined), 1000)),
      ])
    }

    expect(delivered).toBeDefined()
    expect(delivered!.message.topic).toBe(TOPIC)
    expect(delivered!.value).toEqual(payload)
    expect(delivered!.key).toBe('k1')
  })

  it('retries a failing handler in-process until it succeeds over a real broker', async () => {
    resetRetry()
    await built.run()

    const template = built.container.get<KafkaTemplate>(KafkaTemplate)

    const deadline = Date.now() + 25_000
    let attempts: number | undefined
    while (attempts === undefined && Date.now() < deadline) {
      await template.send(RETRY_TOPIC, { will: 'retry' }, { key: 'r1' })
      attempts = await Promise.race([
        retryState.done.promise,
        new Promise<undefined>(res => setTimeout(() => res(undefined), 1500)),
      ])
    }

    // The same delivery is re-invoked in-process; the 3rd attempt succeeds.
    expect(attempts).toBe(3)
  })

  it('retries through non-blocking retry topics until success over a real broker', async () => {
    resetRt()
    await built.run()

    const template = built.container.get<KafkaTemplate>(KafkaTemplate)

    // Send once; the consumer group has already joined from the earlier specs, so no duplicate triggers. The
    // record walks flow's main topic → -retry-0 → -retry-1 (each with its own delay) and succeeds on attempt 3.
    await template.send(RETRY_TOPICS_TOPIC, { will: 'retry-topics' }, { key: 'rt1' })

    const attempts = await Promise.race([
      rtState.done.promise,
      new Promise<undefined>(res => setTimeout(() => res(undefined), 25_000)),
    ])

    expect(attempts).toBe(3)

    // The retry topics were auto-created inheriting the 3-partition source count.
    const admin = new Admin({ clientId: 'caffeine-kafka-it-meta', bootstrapBrokers: [BROKER] })
    try {
      const metadata = await admin.metadata({ topics: [`${RETRY_TOPICS_TOPIC}-retry-0`] })
      expect(metadata.topics.get(`${RETRY_TOPICS_TOPIC}-retry-0`)?.partitionsCount).toBe(3)
    } finally {
      await admin.close()
    }
  })
})
