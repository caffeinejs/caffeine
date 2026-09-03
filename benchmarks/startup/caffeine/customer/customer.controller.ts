import { Controller, Delete, Get, Args, Post, $p } from '@caffeinejs/http'

import { CustomerService } from './customer.service.js'

@Controller('/customers', [CustomerService])
export class CustomerController {
  constructor(private readonly service: CustomerService) {}

  @Get('/')
  findAll(): unknown[] {
    return this.service.findAll()
  }

  @Get('/:id')
  @Args([$p.param('id')])
  findOne(id: string): unknown {
    return this.service.findById(id)
  }

  @Post('/')
  @Args([$p.body()])
  create(body: unknown): unknown {
    return this.service.create(body)
  }

  @Delete('/:id')
  @Args([$p.param('id')])
  remove(id: string): void {
    this.service.delete(id)
  }
}
