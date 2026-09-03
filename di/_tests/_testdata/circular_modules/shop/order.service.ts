import { UserRepository } from './user.repository.js'

export class OrderService {
  constructor(readonly users: UserRepository) {}

  listForUser(userId: string): Array<{ id: string; user: { id: string; name: string } }> {
    return [{ id: 'o-1', user: this.users.findById(userId) }]
  }
}
