import { describe, expect, it } from 'vitest'

import { ErrKafkaUnknownInstance } from './errors.js'

describe('ErrKafkaUnknownInstance', () => {
  it('offers the configured instances to reassign the handler to', () => {
    const err = new ErrKafkaUnknownInstance('Orders.on', 'ghost', ['default', 'orders'])

    expect(err.message).toContain('.install(Kafka("ghost", k => k.brokers(...)))')
    expect(err.message).toContain('to a configured instance: "default", "orders"')
  })

  it('offers no reassignment when no instance is configured', () => {
    // There is nowhere to reassign the handler to, so declaring the instance is the only fix.
    const err = new ErrKafkaUnknownInstance('Orders.on', 'ghost', [])

    expect(err.message).toContain('.install(Kafka("ghost", k => k.brokers(...)))')
    expect(err.message).not.toContain('reassign')
  })
})
