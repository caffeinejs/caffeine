import { Controller, Get, Post, Delete, Param, Body } from '@nestjs/common'
import { CartService } from './cart.service.js'

@Controller('cart')
export class CartController {
  constructor(private readonly service: CartService) {}

  @Get()
  findAll(): unknown[] { return this.service.findAll() }

  @Get(':id')
  findOne(@Param('id') id: string): unknown { return this.service.findById(id) }

  @Post()
  create(@Body() body: unknown): unknown { return this.service.create(body) }

  @Delete(':id')
  remove(@Param('id') id: string): void { this.service.delete(id) }
}
