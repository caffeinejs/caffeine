import { CaffeineIoC, token } from '@caffeinejs/di'
import { createApplication } from '@caffeinejs/std'
import { HealthIndicator, type HealthReport, up } from '@caffeinejs/std/health'
import { describe, expect, it } from 'vitest'

import type { ConsumerClient, KafkaClients, ProducerClient } from './config.js'
import { KafkaHealthIndicator } from './health.js'
import type { KafkaContainerStatus } from './listener_container.js'
import { kafka } from './plugin.js'
import { Keys } from './symbols.js'

function containerWith(statuses: Record<string, KafkaContainerStatus>): CaffeineIoC {
  const ioc = new CaffeineIoC()

  for (const [name, status] of Object.entries(statuses)) {
    ioc.bind(token<Record<string, unknown>>(Symbol(name)), t =>
      t.toValue({ name, status: () => status }).labels(Keys.KAFKA_CONTAINER, Keys.KAFKA_HEALTH),
    )
  }

  return ioc
}

describe('KafkaHealthIndicator', () => {
  it('reports up when every instance is running', async () => {
    const ioc = containerWith({ default: 'running', audit: 'running' })
    await ioc.init()

    expect(new KafkaHealthIndicator(ioc).check()).toMatchObject({
      status: 'up',
      data: { default: 'running', audit: 'running' },
    })
  })

  it('tolerates a rebalance, which is a normal part of group membership', async () => {
    const ioc = containerWith({ default: 'rebalancing' })
    await ioc.init()

    expect(new KafkaHealthIndicator(ioc).check().status).toBe('up')
  })

  it('reports down and names the instance that stopped consuming', async () => {
    const ioc = containerWith({ default: 'running', audit: 'stopped' })
    await ioc.init()

    const report = new KafkaHealthIndicator(ioc).check()

    expect(report.status).toBe('down')
    expect(report.detail).toBe('audit is stopped')
  })

  it('reports down before the consumers have started', async () => {
    const ioc = containerWith({ default: 'idle' })
    await ioc.init()

    expect(new KafkaHealthIndicator(ioc).check().status).toBe('down')
  })

  it('stays out of the way when no instance is configured', async () => {
    const ioc = new CaffeineIoC()
    await ioc.init()

    expect(new KafkaHealthIndicator(ioc).check()).toEqual({ status: 'up' })
  })

  it('contributes to readiness only, never to liveness', () => {
    expect(new KafkaHealthIndicator(new CaffeineIoC()).groups).toEqual(['readiness'])
  })
})

function noopClients(): KafkaClients {
  const producer: ProducerClient = { send: () => Promise.resolve(), close: () => Promise.resolve() }
  const consumer: ConsumerClient = {
    consume: () =>
      Promise.resolve(Object.assign({ async *[Symbol.asyncIterator]() {} }, { close: () => Promise.resolve() })),
    close: () => Promise.resolve(),
  }
  return { createProducer: () => producer, createConsumer: () => consumer }
}

class Database extends HealthIndicator {
  get name(): string {
    return 'database'
  }

  check(): HealthReport {
    return up()
  }
}

// Kafka's indicator used to register only while nothing else extended HealthIndicator, so an application with a
// check of its own lost Kafka's readiness without a word. Readiness is now something each instance asks for.
describe('kafka(k => k.health())', () => {
  it('registers no indicator unless an instance asks for one', async () => {
    const app = createApplication({}).with(kafka(k => k.brokers('localhost:9092'), { clients: noopClients() }))
    await app.ready()

    expect(app.container.has(KafkaHealthIndicator)).toBe(false)

    await app.close()
  })

  it('registers the indicator next to one the application bound', async () => {
    const app = createApplication({}).with(kafka(k => k.brokers('localhost:9092').health(), { clients: noopClients() }))
    app.container.bind(Database, t => t.toSelf().extends(HealthIndicator))
    await app.ready()

    expect(app.container.getMany(HealthIndicator).map(indicator => indicator.name)).toEqual(
      expect.arrayContaining(['database', 'kafka']),
    )

    await app.close()
  })

  it('reports only the instances that asked for it', async () => {
    const app = createApplication({})
      .with(kafka(k => k.brokers('localhost:9092').health(), { clients: noopClients() }))
      .with(kafka('audit', k => k.brokers('localhost:9092'), { clients: noopClients() }))
    await app.ready()

    expect(Object.keys(app.container.get(KafkaHealthIndicator).check().data ?? {})).toEqual(['default'])

    await app.close()
  })
})
