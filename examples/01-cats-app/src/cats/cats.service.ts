import { Injectable } from '@caffeinejs/di'
import type { Cat, CreateCatDTO, UpdateCatDTO } from './cat.js'

@Injectable()
export class CatsService {
  #store = new Map<number, Cat>()
  #nextId = 1

  findAll(): Cat[] {
    return [...this.#store.values()]
  }

  findOne(id: number): Cat | undefined {
    return this.#store.get(id)
  }

  create(dto: CreateCatDTO): Cat {
    const cat: Cat = { id: this.#nextId++, ...dto }
    this.#store.set(cat.id, cat)
    return cat
  }

  update(id: number, dto: UpdateCatDTO): Cat | undefined {
    const existing = this.#store.get(id)
    if (!existing) {
      return undefined
    }
    const updated: Cat = { ...existing, ...dto }
    this.#store.set(id, updated)
    return updated
  }

  remove(id: number): boolean {
    return this.#store.delete(id)
  }
}
