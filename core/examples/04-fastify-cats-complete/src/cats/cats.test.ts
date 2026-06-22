import { Redis } from 'ioredis'
import { describe, it, expect, vi, beforeAll, afterEach, afterAll } from 'vitest'
import { newTestContainer } from '@caffeinejs/core/testing'
import { buildServer } from '../app.js'
import { createContainer } from '../app.container.js'
import { DataConfig } from '../util/gcs/data.config.js'
import type { Cat, CreateCatDTO } from './cat.js'
import { CatsRepository } from './cats.repository.js'
import { catsRoutes } from './cats.routes.js'
import { CatsService } from './cats.service.js'

describe('cats CRUD', function () {
  // We mock the dependencies that we need using any of the typical mocking libraries.
  // We don't need to use the test container for this.

  const mockFindAll = vi.fn<() => Promise<Cat[]>>()
  const mockFindOne = vi.fn<(id: number) => Promise<Cat | undefined>>()
  const mockCreate = vi.fn<(dto: CreateCatDTO) => Promise<Cat>>()
  const mockUpdate = vi.fn()
  const mockRemove = vi.fn()

  const mockRepo = {
    findAll: mockFindAll,
    findOne: mockFindOne,
    create: mockCreate,
    update: mockUpdate,
    remove: mockRemove,
  } as CatsRepository

  const mockRedis = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    keys: vi.fn().mockResolvedValue([]),
    ping: vi.fn().mockResolvedValue('PONG'),
    quit: vi.fn().mockResolvedValue('OK'),
    on: vi.fn(),
  } as unknown as Redis

  function makeMockCat(overrides?: Partial<Cat>): Cat {
    return { id: 1, name: 'Whiskers', breed: 'Siamese', age: 3, ...overrides }
  }

  let server: Awaited<ReturnType<typeof buildServer>>

  beforeAll(async function () {
    // We create the "production" application container and use the TestContainer to
    // exclude what we don't need for the test, and override the dependencies that we need to mock.
    const container = await createContainer()
    const testContainer = newTestContainer(container) // test container based on the production container
      .focus(CatsService)
      .override(CatsRepository, b => b.toValue(mockRepo))
      .override(Redis, b => b.toValue(mockRedis))
      .override(DataConfig, b => b.toValue(new DataConfig({})))
      .build()
    // We must always initialize the container before using it.
    await testContainer.init()

    server = await buildServer(testContainer, { logger: false }, catsRoutes)
    await server.ready()
  })

  afterAll(async function () {
    // server also closes the container with the .onClose hook
    // if it wasn't the case, we should call testContainer.dispose() manually
    // after closing the server
    await server.close()
  })

  afterEach(function () {
    vi.clearAllMocks()
  })

  describe('GET /cats', function () {
    it('returns all cats', async function () {
      const cats = [makeMockCat(), makeMockCat({ id: 2, name: 'Luna' })]
      mockFindAll.mockResolvedValue(cats)

      const response = await server.inject({ method: 'GET', url: '/cats' })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual(cats)
    })
  })

  describe('GET /cats/:id', function () {
    it('returns a cat when found', async function () {
      const cat = makeMockCat()
      mockFindOne.mockResolvedValue(cat)

      const response = await server.inject({ method: 'GET', url: '/cats/1' })

      expect(mockFindOne).toHaveBeenCalledWith(1)
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual(cat)
    })

    it('returns 404 when not found', async function () {
      mockFindOne.mockResolvedValue(undefined)

      const response = await server.inject({ method: 'GET', url: '/cats/99' })

      expect(response.statusCode).toBe(404)
    })
  })

  describe('POST /cats', function () {
    it('creates and returns a new cat', async function () {
      const dto: CreateCatDTO = { name: 'Luna', breed: 'Persian', age: 2 }
      const cat = makeMockCat({ ...dto })
      mockCreate.mockResolvedValue(cat)

      const response = await server.inject({
        method: 'POST',
        url: '/cats',
        payload: dto,
      })

      expect(mockCreate).toHaveBeenCalledWith(dto)
      expect(response.statusCode).toBe(201)
      expect(response.json()).toEqual(cat)
    })
  })

  describe('PUT /cats/:id', function () {
    it('updates and returns the cat', async function () {
      const updated = makeMockCat({ name: 'Cleo' })
      mockUpdate.mockResolvedValue(updated)

      const response = await server.inject({
        method: 'PUT',
        url: '/cats/1',
        payload: { name: 'Cleo' },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual(updated)
    })

    it('returns 404 when cat not found', async function () {
      mockUpdate.mockResolvedValue(undefined)

      const response = await server.inject({
        method: 'PUT',
        url: '/cats/99',
        payload: { name: 'Ghost' },
      })

      expect(response.statusCode).toBe(404)
    })
  })

  describe('DELETE /cats/:id', function () {
    it('removes the cat and returns 204', async function () {
      mockRemove.mockResolvedValue(true)

      const response = await server.inject({ method: 'DELETE', url: '/cats/1' })

      expect(response.statusCode).toBe(204)
    })

    it('returns 404 when cat not found', async function () {
      mockRemove.mockResolvedValue(false)

      const response = await server.inject({ method: 'DELETE', url: '/cats/99' })

      expect(response.statusCode).toBe(404)
    })
  })
})
