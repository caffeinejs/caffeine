import type { User, CreateUserDTO, UpdateUserDTO } from './user.js'
import type { UsersRepository } from './user.repository.js'

export class UsersController {
  constructor(private readonly repository: UsersRepository) {}

  findAll(): User[] {
    return this.repository.findAll()
  }

  findOne(id: number): User | undefined {
    return this.repository.findOne(id)
  }

  create(dto: CreateUserDTO): User {
    return this.repository.create(dto)
  }

  update(id: number, dto: UpdateUserDTO): User | undefined {
    return this.repository.update(id, dto)
  }

  remove(id: number): boolean {
    return this.repository.remove(id)
  }
}
