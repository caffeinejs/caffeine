import { Controller, Delete, ErrNotFound, Get, Params, Post, Schema, Status, $p } from '@caffeinejs/http'
import type { CreateOrderDTO } from './order.js'
import { createOrderSchema, orderIdParamSchema } from './order.js'
import { OrdersRepository } from './orders.repository.js'

@Controller('/orders', [OrdersRepository])
export class OrdersController {
  constructor(private readonly orders: OrdersRepository) {}

  @Post('/')
  @Status(201)
  @Schema({ body: createOrderSchema })
  @Params([$p.body()])
  create(dto: CreateOrderDTO) {
    // A missing pet throws ErrPetNotFound (an ErrNotFound) → 404 problem+json via the global handler.
    return this.orders.create(dto)
  }

  @Get('/:id')
  @Schema({ params: orderIdParamSchema })
  @Params([$p.param('id')])
  async get(id: string) {
    const order = await this.orders.get(id)
    if (!order) {
      throw new ErrNotFound(`The requested order with ID "${id}" was not found`)
    }
    return order
  }

  @Delete('/:id')
  @Status(204)
  @Schema({ params: orderIdParamSchema })
  @Params([$p.param('id')])
  async remove(id: string) {
    await this.orders.remove(id)
  }
}
