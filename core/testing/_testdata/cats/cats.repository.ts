import type { Cat, CreateCatDTO, UpdateCatDTO } from './cats.js'

export interface CatsRepository {
  findAll(): Cat[]
  findOne(id: number): Cat | undefined
  create(dto: CreateCatDTO): Cat
  update(id: number, dto: UpdateCatDTO): Cat | undefined
  remove(id: number): boolean
}

export class CatsInMemoryRepository implements CatsRepository {
  private readonly store: Cat[] = []
  private seq = 1

  findAll(): Cat[] {
    return this.store
  }

  findOne(id: number): Cat | undefined {
    return this.store.find(c => c.id === id)
  }

  create(dto: CreateCatDTO): Cat {
    const cat: Cat = { id: this.seq++, ...dto }
    this.store.push(cat)
    return cat
  }

  update(id: number, dto: UpdateCatDTO): Cat | undefined {
    const cat = this.store.find(c => c.id === id)
    if (cat === undefined) {
      return undefined
    }
    Object.assign(cat, dto)
    return cat
  }

  remove(id: number): boolean {
    const idx = this.store.findIndex(c => c.id === id)
    if (idx === -1) {
      return false
    }
    this.store.splice(idx, 1)
    return true
  }
}
