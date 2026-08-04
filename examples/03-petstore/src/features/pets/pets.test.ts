import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { WebApplication } from '@caffeinejs/http'
import { ErrFetchFailed, newRequest, newTestContainer, newURL, typedClient } from '@caffeinejs/testing'
import { createContainer } from '../../app.container.js'
import { buildApp } from '../../app.js'
import { signToken } from '../auth/tokens.js'
import type { CreatePetDTO, PetCollection, PetDTO, PetFilters, UpdatePetDTO } from './pet.js'
import { PetsController } from './pets.controller.js'
import { PetsRepository } from './pets.repository.js'

// In-memory stand-in for the Prisma-backed repository, so the feature is tested with no database.
class FakePetsRepository {
  readonly #pets = new Map<string, PetDTO>()

  reset(): void {
    this.#pets.clear()
  }

  async list(filters: PetFilters): Promise<PetCollection> {
    return this.#collection([...this.#pets.values()], filters.page, filters.limit)
  }

  async search(): Promise<PetCollection> {
    return this.#collection([...this.#pets.values()], 1, 20)
  }

  async get(id: string): Promise<PetDTO | undefined> {
    return this.#pets.get(id)
  }

  async create(dto: CreatePetDTO): Promise<PetDTO> {
    const now = new Date().toISOString()
    const pet: PetDTO = {
      id: randomUUID(),
      species: dto.species,
      name: dto.name,
      breed: dto.breed,
      ageMonths: dto.ageMonths,
      size: dto.size,
      color: dto.color,
      gender: dto.gender,
      goodWithKids: dto.goodWithKids,
      price: dto.price,
      currency: dto.currency ?? 'USD',
      description: dto.description,
      status: dto.status ?? 'AVAILABLE',
      photos: dto.photos ?? [],
      medicalInfo: dto.medicalInfo,
      createdAt: now,
      updatedAt: now,
    }
    this.#pets.set(pet.id, pet)
    return pet
  }

  async update(id: string, dto: UpdatePetDTO): Promise<PetDTO | undefined> {
    const current = this.#pets.get(id)
    if (!current) {
      return undefined
    }
    const updated: PetDTO = { ...current, ...dto, id: current.id, updatedAt: new Date().toISOString() }
    this.#pets.set(id, updated)
    return updated
  }

  async addPhoto(id: string, url: string): Promise<PetDTO | undefined> {
    const current = this.#pets.get(id)
    if (!current) {
      return undefined
    }
    const updated: PetDTO = { ...current, photos: [...current.photos, url] }
    this.#pets.set(id, updated)
    return updated
  }

  async remove(id: string): Promise<boolean> {
    return this.#pets.delete(id)
  }

  #collection(data: PetDTO[], page: number, limit: number): PetCollection {
    return {
      data,
      pagination: { page, limit, totalItems: data.length, totalPages: Math.max(1, Math.ceil(data.length / limit)) },
    }
  }
}

const validPet: CreatePetDTO = { species: 'DOG', name: 'Rex', ageMonths: 12, price: '100.00' }

describe('pets feature (via @caffeinejs/testing)', () => {
  const fake = new FakePetsRepository()
  let app: WebApplication<any, any, any>
  let client: ReturnType<typeof typedClient<typeof PetsController>>
  let token: string

  beforeAll(async () => {
    // Base the test container on the real application container, override just the pets repository.
    const container = newTestContainer(createContainer())
      .override(PetsRepository, b => b.toValue(fake as unknown as PetsRepository))
      .build()

    app = buildApp(container, { logger: false })
    await app.ready()

    token = await signToken('tester', ['write:pets'])

    client = typedClient(PetsController, app)
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    fake.reset()
  })

  async function createPet(dto: CreatePetDTO = validPet): Promise<PetDTO> {
    return client.create(newRequest().bearer(token).json(dto).build())
  }

  it('lists an empty collection, then reflects a created pet', async () => {
    expect((await client.list()).data).toEqual([])

    await createPet()

    const collection = await client.list()
    expect(collection.data).toHaveLength(1)
    expect(collection.data[0]).toMatchObject({ name: 'Rex', species: 'DOG' })
  })

  it('creates a pet (write:pets) and echoes the DTO', async () => {
    const pet = await createPet()
    expect(pet).toMatchObject({ name: 'Rex', species: 'DOG', status: 'AVAILABLE', currency: 'USD' })
    expect(pet.id).toMatch(/[0-9a-f-]{36}/)
  })

  it('rejects create without a token (write:pets) with 401', async () => {
    await expect(
      client.create(newRequest().json(validPet).build()),
    ).rejects.toMatchObject({ status: 401 })
  })

  it('gets a pet by id via a newURL-built Request', async () => {
    const created = await createPet()

    const pet = await client.get(new Request(newURL('/pets/:id').param('id', created.id).build()))
    expect(pet).toMatchObject({ id: created.id, name: 'Rex' })
  })

  it('returns 404 for an unknown id', async () => {
    await expect(
      client.get(new Request(newURL('/pets/:id').param('id', randomUUID()).build())),
    ).rejects.toBeInstanceOf(ErrFetchFailed)
    await expect(
      client.get(new Request(newURL('/pets/:id').param('id', randomUUID()).build())),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('updates a pet by id', async () => {
    const created = await createPet()

    const updated = await client.update(newRequest()
      .path(newURL('/pets/:id').param('id', created.id).build())
      .method('PUT')
      .bearer(token)
      .json({ name: 'Rex II' })
      .toRequest())
    expect(updated).toMatchObject({ id: created.id, name: 'Rex II' })
  })

  it('removes a pet by id (204) and then 404s on read', async () => {
    const created = await createPet()

    const removed = await client.remove(new Request(
      newURL('/pets/:id').param('id', created.id).build(),
      newRequest().method('DELETE').bearer(token).build(),
    ))
    expect(removed).toBeUndefined()

    await expect(
      client.get(new Request(newURL('/pets/:id').param('id', created.id).build())),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('searches (QUERY /pets) and returns a collection', async () => {
    await createPet()

    const collection = await client.search(newRequest().json({ criteria: { species: ['DOG'] } }).build())
    expect(collection.data).toHaveLength(1)
    expect(collection.pagination).toMatchObject({ page: 1, limit: 20, totalItems: 1 })
  })
})
