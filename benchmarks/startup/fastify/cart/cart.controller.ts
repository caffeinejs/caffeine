import { CartService } from './cart.service.js'

export class CartController {
  constructor(private readonly service: CartService) {}

  findAll(): unknown[] {
    return this.service.findAll()
  }
  findOne(id: string): unknown {
    return this.service.findById(id)
  }
  create(data: unknown): unknown {
    return this.service.create(data)
  }
  delete(id: string): void {
    this.service.delete(id)
  }
}
