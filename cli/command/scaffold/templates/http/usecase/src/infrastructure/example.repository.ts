import { Injectable } from '@caffeinejs/core'
import type { Example } from '../domain/example.entity.js'

@Injectable()
export class ExampleRepository {
  private readonly items: Example[] = []

  findAll(): Example[] {
    return this.items
  }

  findById(id: string): Example | undefined {
    return this.items.find(item => item.id === id)
  }

  create(name: string): Example {
    const item: Example = { id: crypto.randomUUID(), name }
    this.items.push(item)
    return item
  }
}
