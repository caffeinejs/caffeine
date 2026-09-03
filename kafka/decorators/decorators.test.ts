import { CaffeineIoC } from '@caffeinejs/di'
import { describe, it, expect } from 'vitest'

import { Keys } from '../symbols.js'
import { KafkaHandler } from './kafka_handler.js'
import { KafkaListener } from './kafka_listener.js'
import { getHandlerListeners } from './registrar.js'

describe('@KafkaHandler / @KafkaListener', () => {
  it('records a listener spec per decorated method', () => {
    @KafkaHandler()
    class OrdersConsumer {
      @KafkaListener({ topic: 'orders', groupId: 'orders-service' })
      onOrder() {}
    }

    const [spec, ...rest] = getHandlerListeners(OrdersConsumer)
    expect(rest).toHaveLength(0)
    expect(spec).toMatchObject({ handlerName: 'onOrder', topics: ['orders'], groupId: 'orders-service' })
  })

  it('supports multiple listener methods on one handler class', () => {
    @KafkaHandler()
    class MultiConsumer {
      @KafkaListener({ topic: 'a' })
      onA() {}

      @KafkaListener({ topics: ['b', 'c'], autocommit: false })
      onBC() {}
    }

    const specs = getHandlerListeners(MultiConsumer)
    expect(specs).toHaveLength(2)
    expect(specs.find(s => s.handlerName === 'onA')?.topics).toEqual(['a'])
    const bc = specs.find(s => s.handlerName === 'onBC')
    expect(bc?.topics).toEqual(['b', 'c'])
    expect(bc?.autocommit).toBe(false)
  })

  it('labels the class for discovery and tags it with the default instance', () => {
    @KafkaHandler()
    class LabelledConsumer {
      @KafkaListener({ topic: 't' })
      on() {}
    }

    const container = new CaffeineIoC()
    const discovered = container.getBindingsByLabel(Keys.KAFKA_HANDLER)
    const found = discovered.find(d => d.binding.type === LabelledConsumer)
    expect(found).toBeDefined()
    expect(found!.binding.tags.get(Keys.KAFKA_INSTANCE)).toBe('default')
  })

  it('tags the class with an explicit instance name', () => {
    @KafkaHandler({ instance: 'orders' })
    class OrdersScoped {
      @KafkaListener({ topic: 't' })
      on() {}
    }

    const container = new CaffeineIoC()
    const found = container.getBindingsByLabel(Keys.KAFKA_HANDLER).find(d => d.binding.type === OrdersScoped)
    expect(found!.binding.tags.get(Keys.KAFKA_INSTANCE)).toBe('orders')
  })

  it('returns no specs for an undecorated class', () => {
    class Plain {}
    expect(getHandlerListeners(Plain)).toEqual([])
  })
})
