import { ErrHTTPNotFound, Router } from '@caffeinejs/http'
import { apiGroup, operation } from '@caffeinejs/openapi'

import { APIErrorSchema } from '../util/errors/index.js'
import { OrdersRepository } from './orders.repository.js'
import { CreateOrderSchema, OrderIdParamSchema, OrderSchema } from './orders.schemas.js'

/**
 * Orders, declared as a router rather than a controller.
 *
 * Same compilation as a controller — the same guards, authorization, validation and error handling — with the
 * configuration written as a chain. `apiGroup()` and `operation()` are the very functions `@APIGroup` and
 * `@Operation` call, so the generated document cannot tell the two styles apart.
 *
 * What a router adds is its type: each `.handler()` returns the group re-typed with the route just closed, so
 * the exported value carries every route's method, path and schemas. That is what `@caffeinejs/brewer` reads to
 * type a client, and what `orders.test.ts` exercises.
 */
const orders = new Router('/orders')
  .name('Orders')
  .with(apiGroup({ name: 'Orders', description: 'Place and track adoption orders.' }))
  .inject({ repository: OrdersRepository })
  // Bare, so every route asks for the application's default policy — an authenticated caller. The same thing
  // `@Authorize()` declares on a controller.
  .authorize({})

export const ordersRouter = orders
  .post('/')
  .status(201)
  .schema({
    body: CreateOrderSchema,
    response: { 201: OrderSchema, 404: APIErrorSchema, 422: APIErrorSchema },
  })
  .with(
    operation({
      operationId: 'createOrder',
      summary: 'Place an adoption order',
      responses: { 404: { description: 'No pet exists with the given petId' } },
    }),
  )
  // A missing pet throws ErrPetNotFound (an ErrHTTPNotFound) → 404 { code, message } via the global handler.
  .handler((ctx, deps) => deps.repository.create(ctx.req.body()))

  .get('/:id')
  .schema({
    params: OrderIdParamSchema,
    response: { 200: OrderSchema, 404: APIErrorSchema },
  })
  .with(operation({ operationId: 'getOrder', summary: 'Get an order by ID' }))
  .handler(async (ctx, deps) => {
    const order = await deps.repository.get(ctx.req.param().id)
    if (!order) {
      throw new ErrHTTPNotFound(`The requested order with ID "${ctx.req.param().id}" was not found`)
    }

    return order
  })

  .delete('/:id')
  .status(204)
  .schema({ params: OrderIdParamSchema })
  .with(operation({ operationId: 'deleteOrder', summary: 'Cancel an order' }))
  .handler(async (ctx, deps) => {
    await deps.repository.remove(ctx.req.param().id)
  })
