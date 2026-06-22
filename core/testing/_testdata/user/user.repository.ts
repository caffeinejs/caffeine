import type { User, CreateUserDTO, UpdateUserDTO } from './user.js'

export interface UsersRepository {
  findAll(): User[]
  findOne(id: number): User | undefined
  create(dto: CreateUserDTO): User
  update(id: number, dto: UpdateUserDTO): User | undefined
  remove(id: number): boolean
}

export class UsersInMemoryRepository implements UsersRepository {
  private readonly store: User[] = []
  private seq = 1

  findAll(): User[] {
    return this.store
  }

  findOne(id: number): User | undefined {
    return this.store.find(u => u.id === id)
  }

  create(dto: CreateUserDTO): User {
    const user: User = { id: this.seq++, ...dto }
    this.store.push(user)
    return user
  }

  update(id: number, dto: UpdateUserDTO): User | undefined {
    const user = this.store.find(u => u.id === id)
    if (user === undefined) {
      return undefined
    }
    Object.assign(user, dto)
    return user
  }

  remove(id: number): boolean {
    const idx = this.store.findIndex(u => u.id === id)
    if (idx === -1) {
      return false
    }
    this.store.splice(idx, 1)
    return true
  }
}
