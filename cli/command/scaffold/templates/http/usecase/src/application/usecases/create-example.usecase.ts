import { Injectable } from '@caffeinejs/core'
import type { Example } from '../../domain/example.entity.js'
import { ExampleRepository } from '../../infrastructure/example.repository.js'

@Injectable()
export class CreateExampleUseCase {
  constructor(private readonly repo: ExampleRepository) {}

  execute(name: string): Example {
    return this.repo.create(name)
  }
}
