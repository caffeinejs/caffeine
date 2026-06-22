import type { Cat, CreateCatDTO, UpdateCatDTO } from './cat.js'

export abstract class CatsRepository {
  abstract findAll(): Promise<Cat[]>
  abstract findOne(id: number): Promise<Cat | undefined>
  abstract create(dto: CreateCatDTO): Promise<Cat>
  abstract update(id: number, dto: UpdateCatDTO): Promise<Cat | undefined>
  abstract remove(id: number): Promise<boolean>
}
