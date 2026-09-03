import { Injectable } from '@caffeinejs/di'

import type { Example } from '../../domain/example.entity.js'
import { ExampleRepository } from '../../infrastructure/example.repository.js'

@Injectable()
export class ListExamplesUseCase {
  constructor(private readonly repo: ExampleRepository) {}

  execute(): Example[] {
    return this.repo.findAll()
  }
}
