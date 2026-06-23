import { Controller, Get, Post, Delete, Param, Body } from '@nestjs/common'
import { OrderService } from './order.service.js'

@Controller('orders')
export class OrderController {
  constructor(private readonly service: OrderService) {}

  @Get()
  findAll(): unknown[] { return this.service.findAll() }

  @Get(':id')
  findOne(@Param('id') id: string): unknown { return this.service.findById(id) }

  @Post()
  create(@Body() body: unknown): unknown { return this.service.create(body) }

  @Delete(':id')
  remove(@Param('id') id: string): void { this.service.delete(id) }
}
