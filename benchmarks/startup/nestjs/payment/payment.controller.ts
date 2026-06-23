import { Controller, Get, Post, Delete, Param, Body } from '@nestjs/common'
import { PaymentService } from './payment.service.js'

@Controller('payments')
export class PaymentController {
  constructor(private readonly service: PaymentService) {}

  @Get()
  findAll(): unknown[] { return this.service.findAll() }

  @Get(':id')
  findOne(@Param('id') id: string): unknown { return this.service.findById(id) }

  @Post()
  process(@Body() body: unknown): unknown { return this.service.process(body) }

  @Delete(':id')
  remove(@Param('id') id: string): void { this.service.delete(id) }
}
