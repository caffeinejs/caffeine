import type { Dog, CreateDogDTO, UpdateDogDTO } from './dogs.js'

export interface DogsRepository {
  findAll(): Dog[]
  findOne(id: number): Dog | undefined
  create(dto: CreateDogDTO): Dog
  update(id: number, dto: UpdateDogDTO): Dog | undefined
  remove(id: number): boolean
}

export class DogsInMemoryRepository implements DogsRepository {
  private readonly store: Dog[] = []
  private seq = 1

  findAll(): Dog[] {
    return this.store
  }

  findOne(id: number): Dog | undefined {
    return this.store.find(d => d.id === id)
  }

  create(dto: CreateDogDTO): Dog {
    const dog: Dog = { id: this.seq++, ...dto }
    this.store.push(dog)
    return dog
  }

  update(id: number, dto: UpdateDogDTO): Dog | undefined {
    const dog = this.store.find(d => d.id === id)
    if (dog === undefined) {
      return undefined
    }
    Object.assign(dog, dto)
    return dog
  }

  remove(id: number): boolean {
    const idx = this.store.findIndex(d => d.id === id)
    if (idx === -1) {
      return false
    }
    this.store.splice(idx, 1)
    return true
  }
}
