import { Controller, Delete, Get, Args, Post, $p, type ActionResult } from '@caffeinejs/http'

import { OrderService } from './order.service.js'

@Controller('/orders', [OrderService])
export class OrderController {
  constructor(private readonly service: OrderService) {}

  @Get('/')
  findAll(): unknown[] {
    return this.service.findAll()
  }

  @Get('/:id')
  @Args([$p.param('id')])
  findOne(id: string): ActionResult {
    return this.service.findById(id) as ActionResult
  }

  @Post('/')
  @Args([$p.body()])
  create(body: unknown): ActionResult {
    return this.service.create(body) as ActionResult
  }

  @Delete('/:id')
  @Args([$p.param('id')])
  remove(id: string): void {
    this.service.delete(id)
  }
}
