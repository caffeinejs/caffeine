import type { Cat, CreateCatDTO, UpdateCatDTO } from './cats.js'
import type { CatsRepository } from './cats.repository.js'

export class CatsController {
  constructor(private readonly repository: CatsRepository) {}

  findAll(): Cat[] {
    return this.repository.findAll()
  }

  findOne(id: number): Cat | undefined {
    return this.repository.findOne(id)
  }

  create(dto: CreateCatDTO): Cat {
    return this.repository.create(dto)
  }

  update(id: number, dto: UpdateCatDTO): Cat | undefined {
    return this.repository.update(id, dto)
  }

  remove(id: number): boolean {
    return this.repository.remove(id)
  }
}
