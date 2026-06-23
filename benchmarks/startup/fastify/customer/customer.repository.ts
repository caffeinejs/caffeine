export class CustomerRepository {
  findAll(): unknown[] { return [] }
  findById(id: string): unknown { return { id } }
  save(data: unknown): unknown { return data }
  delete(id: string): void { void id }
}
