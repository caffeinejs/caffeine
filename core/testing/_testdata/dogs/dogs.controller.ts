import type { Dog, CreateDogDTO, UpdateDogDTO } from './dogs.js'
import type { DogsRepository } from './dogs.repository.js'

export class DogsController {
  constructor(private readonly repository: DogsRepository) {}

  findAll(): Dog[] {
    return this.repository.findAll()
  }

  findOne(id: number): Dog | undefined {
    return this.repository.findOne(id)
  }

  create(dto: CreateDogDTO): Dog {
    return this.repository.create(dto)
  }

  update(id: number, dto: UpdateDogDTO): Dog | undefined {
    return this.repository.update(id, dto)
  }

  remove(id: number): boolean {
    return this.repository.remove(id)
  }
}
