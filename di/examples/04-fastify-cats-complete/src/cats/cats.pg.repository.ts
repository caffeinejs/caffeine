import pg from 'pg'
import { type Provider } from '@caffeinejs/di'
import { $i, Extends, Injectable } from '@caffeinejs/di'
import { kPgPool } from '../keys.js'
import { RequestContext } from '../util/request/request.context.js'
import type { Cat, CreateCatDTO, UpdateCatDTO } from './cat.js'
import { CatsRepository } from './cats.repository.js'

@Injectable([kPgPool, $i.provide(RequestContext)])
@Extends()
export class CatsPgRepository extends CatsRepository {
  constructor(private readonly pool: pg.Pool, private readonly ctx: Provider<RequestContext>) {
    super()
  }

  async findAll(): Promise<Cat[]> {
    console.log(`[${this.ctx.get().correlationID}] findAll`)

    const result = await this.pool.query<Cat>('SELECT id, name, breed, age FROM cats ORDER BY id')

    return result.rows
  }

  async findOne(id: number): Promise<Cat | undefined> {
    console.log(`[${this.ctx.get().correlationID}] findOne id=${id}`)

    const result = await this.pool.query<Cat>('SELECT id, name, breed, age FROM cats WHERE id = $1', [id])

    return result.rows[0]
  }

  async create(dto: CreateCatDTO): Promise<Cat> {
    console.log(`[${this.ctx.get().correlationID}] create`)

    const result = await this.pool.query<Cat>(
      'INSERT INTO cats (name, breed, age) VALUES ($1, $2, $3) RETURNING id, name, breed, age',
      [dto.name, dto.breed, dto.age],
    )

    return result.rows[0]!
  }

  async update(id: number, dto: UpdateCatDTO): Promise<Cat | undefined> {
    console.log(`[${this.ctx.get().correlationID}] update id=${id}`)

    const fields: string[] = []
    const values: unknown[] = []
    let idx = 1

    if (dto.name !== undefined) {
      fields.push(`name = $${idx++}`)
      values.push(dto.name)
    }

    if (dto.breed !== undefined) {
      fields.push(`breed = $${idx++}`)
      values.push(dto.breed)
    }

    if (dto.age !== undefined) {
      fields.push(`age = $${idx++}`)
      values.push(dto.age)
    }

    if (fields.length === 0) {
      return this.findOne(id)
    }

    values.push(id)
    const result = await this.pool.query<Cat>(
      `UPDATE cats SET ${fields.join(', ')} WHERE id = $${idx} RETURNING id, name, breed, age`,
      values,
    )

    return result.rows[0]
  }

  async remove(id: number): Promise<boolean> {
    console.log(`[${this.ctx.get().correlationID}] remove id=${id}`)

    const result = await this.pool.query('DELETE FROM cats WHERE id = $1', [id])

    return (result.rowCount ?? 0) > 0
  }
}
