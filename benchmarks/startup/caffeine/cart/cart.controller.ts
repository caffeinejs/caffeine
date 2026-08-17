import { Controller, Delete, Get, Params, Post, $p } from '@caffeinejs/http'
import { CartService } from './cart.service.js'

@Controller('/cart', [CartService])
export class CartController {
  constructor(private readonly service: CartService) {}

  @Get('/')
  findAll(): unknown[] { return this.service.findAll() }

  @Get('/:id')
  @Params([$p.param('id')])
  findOne(id: string): unknown { return this.service.findById(id) }

  @Post('/')
  @Params([$p.body()])
  create(body: unknown): unknown { return this.service.create(body) }

  @Delete('/:id')
  @Params([$p.param('id')])
  remove(id: string): void { this.service.delete(id) }
}
