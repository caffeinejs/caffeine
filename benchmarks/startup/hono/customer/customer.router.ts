import { Hono } from 'hono'

import type { CustomerController } from './customer.controller.js'

export function createCustomerRouter(ctrl: CustomerController): Hono {
  const router = new Hono()
  router.get('/', c => c.json(ctrl.findAll()))
  router.get('/:id', c => c.json(ctrl.findOne(c.req.param('id'))))
  router.post('/', async c => c.json(ctrl.create(await c.req.json())))
  router.delete('/:id', c => {
    ctrl.delete(c.req.param('id'))
    return c.json(null)
  })
  return router
}
