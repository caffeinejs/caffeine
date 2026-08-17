import { Injectable } from '@caffeinejs/di'

@Injectable()
export class CartRepository {
  findAll(): unknown[] { return [] }
  findById(id: string): unknown { return { id } }
  save(data: unknown): unknown { return data }
  delete(id: string): void { void id }
}
