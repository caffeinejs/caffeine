import { Controller, Delete, Get, Args, Post, $p, type ActionResult } from '@caffeinejs/http'

import { PaymentService } from './payment.service.js'

@Controller('/payments', [PaymentService])
export class PaymentController {
  constructor(private readonly service: PaymentService) {}

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
  process(body: unknown): ActionResult {
    return this.service.process(body) as ActionResult
  }

  @Delete('/:id')
  @Args([$p.param('id')])
  remove(id: string): void {
    this.service.delete(id)
  }
}
