import { describe, expect, it, vi } from 'vitest'

import { buildServer } from '../app.js'
import { CATS_REPOSITORY, createContainer } from '../dependencies.js'
import type { CatsRepository } from './cats.repository.js'
import { catsRoutes } from './cats.routes.js'

describe('GET /cats/:id', function () {
  it('should return a cat when found', async function (t) {
    const mockFindOne = vi.fn()
    const mockRepo: CatsRepository = {
      findAll: vi.fn(),
      findOne: mockFindOne,
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    }

    const container = createContainer()
    container.rebind(CATS_REPOSITORY, t => t.toValue(mockRepo))

    await container.init()

    const { server } = await buildServer({}, container, catsRoutes)
    await server.ready()

    t.onTestFinished(async function () {
      await server.close()
      await container.dispose()
    })

    const cat = { id: 1, name: 'Whiskers', breed: 'Siamese', age: 3 }
    mockFindOne.mockReturnValue(cat)

    const response = await server.inject({
      method: 'GET',
      url: '/cats/1',
    })

    expect(mockFindOne).toHaveBeenCalledWith(1)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(cat)
  })
})
