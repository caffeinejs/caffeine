import { Controller, Delete, Get, Params, Post, $p } from '@caffeinejs/http'
import { AddressService } from './address.service.js'

@Controller('/addresses', [AddressService])
export class AddressController {
  constructor(private readonly service: AddressService) {}

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
