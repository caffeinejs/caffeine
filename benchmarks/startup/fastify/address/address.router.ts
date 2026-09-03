import type { FastifyInstance } from 'fastify'

import type { AddressController } from './address.controller.js'

export function createAddressRouter(ctrl: AddressController) {
  return async (app: FastifyInstance) => {
    app.get('/', () => ctrl.findAll())
    app.get('/:id', req => ctrl.findOne((req.params as { id: string }).id))
    app.post('/', req => ctrl.create(req.body))
    app.delete('/:id', req => {
      ctrl.delete((req.params as { id: string }).id)
    })
  }
}
