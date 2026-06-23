import { AddressService } from './address.service.js'

export class AddressController {
  constructor(private readonly service: AddressService) {}

  findAll(): unknown[] { return this.service.findAll() }
  findOne(id: string): unknown { return this.service.findById(id) }
  create(data: unknown): unknown { return this.service.create(data) }
  delete(id: string): void { this.service.delete(id) }
}
