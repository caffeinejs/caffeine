import type { FastifyInstance } from 'fastify'

import type { PaymentController } from './payment.controller.js'

export function createPaymentRouter(ctrl: PaymentController) {
  return async (app: FastifyInstance) => {
    app.get('/', () => ctrl.findAll())
    app.get('/:id', req => ctrl.findOne((req.params as { id: string }).id))
    app.post('/', req => ctrl.process(req.body))
    app.delete('/:id', req => {
      ctrl.delete((req.params as { id: string }).id)
    })
  }
}
