import type { FastifyInstance } from 'fastify'
import type { CustomerController } from './customer.controller.js'

export function createCustomerRouter(ctrl: CustomerController) {
  return async (app: FastifyInstance) => {
    app.get('/', () => ctrl.findAll())
    app.get('/:id', req => ctrl.findOne((req.params as { id: string }).id))
    app.post('/', req => ctrl.create(req.body))
    app.delete('/:id', req => {
      ctrl.delete((req.params as { id: string }).id)
    })
  }
}
