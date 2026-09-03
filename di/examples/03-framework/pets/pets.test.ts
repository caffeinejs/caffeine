import { describe, expect, it, vi } from 'vitest'

import { PetsController } from './pets.controller.js'
import { PetsRepository } from './pets.repo.js'

describe('PetsController', function () {
  it('should create a pet', function () {
    const pet = { id: 0, name: 'Fluffy', type: 'cat' }
    const created = { ...pet, id: 1 }

    const mockRepo: PetsRepository = {
      all: vi.fn(),
      byID: vi.fn(),
      create: vi.fn().mockReturnValue(created),
      update: vi.fn(),
      delete: vi.fn(),
    }

    const controller = new PetsController(mockRepo)
    const result = controller.create(pet)

    expect(mockRepo.create).toHaveBeenCalledWith(pet)
    expect(result).toEqual(created)
  })
})
