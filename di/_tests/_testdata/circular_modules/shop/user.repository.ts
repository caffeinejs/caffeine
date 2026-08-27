export class UserRepository {
  findById(id: string): { id: string, name: string } {
    return { id, name: 'Ada' }
  }
}
