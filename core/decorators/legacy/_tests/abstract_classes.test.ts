import 'reflect-metadata'
import { describe, expect, it, vi } from 'vitest'
import { Injectable } from '../injectable.js'
import { Extends } from '../extends.js'
import { DiCaf } from '../../../container.js'

describe('Legacy Abstract Classes', function () {
  describe('when a class has a constructor parameter of an abstract class', function () {
    it('should infer the injection key from as the abstract class ctor the type automatically', async function () {
      const spy = vi.fn()

      abstract class Notifier {
        abstract send(msg: string): void
      }

      @Injectable()
      @Extends()
      class EmailNotifier extends Notifier {
        send(msg: string) {
          spy(msg)
        }
      }

      @Injectable()
      class OrderService {
        constructor(readonly notifier: Notifier) {}

        place(item: string) {
          this.notifier.send(`Order placed: ${item}`)
        }
      }

      const di = new DiCaf()
      await di.init()

      const orderService = di.get(OrderService)
      orderService.place('Laptop')

      expect(spy).toHaveBeenCalledWith('Order placed: Laptop')
    })
  })
})
