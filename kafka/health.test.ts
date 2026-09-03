import { CaffeineIoC, token } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import { KafkaHealthIndicator } from './health.js'
import type { KafkaContainerStatus } from './listener_container.js'
import { Keys } from './symbols.js'

function containerWith(statuses: Record<string, KafkaContainerStatus>): CaffeineIoC {
  const ioc = new CaffeineIoC()

  for (const [name, status] of Object.entries(statuses)) {
    ioc.bind(token<any>(Symbol(name)), t => t.toValue({ name, status: () => status }).labels(Keys.KAFKA_CONTAINER))
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
