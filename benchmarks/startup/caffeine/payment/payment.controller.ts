import { Controller, Delete, Get, Args, Post, $p } from '@caffeinejs/http'
import { PaymentService } from './payment.service.js'

@Controller('/payments', [PaymentService])
export class PaymentController {
  constructor(private readonly service: PaymentService) {}

  @Get('/')
  findAll(): unknown[] { return this.service.findAll() }

  @Get('/:id')
  @Args([$p.param('id')])
  findOne(id: string): unknown { return this.service.findById(id) }

  @Post('/')
  @Args([$p.body()])
  process(body: unknown): unknown { return this.service.process(body) }

  @Delete('/:id')
  @Args([$p.param('id')])
  remove(id: string): void { this.service.delete(id) }
}
