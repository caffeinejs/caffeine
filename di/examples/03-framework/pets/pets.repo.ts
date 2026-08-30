import { Injectable, token } from '@caffeinejs/di'
import { Pet } from './pets.js'

export interface PetsRepository {
  all(): Pet[]
  byID(id: number): Pet | undefined
  create(pet: Pet): Pet
  update(id: number, pet: Pet): Pet | undefined
  delete(id: number): boolean
}

export const kPetsRepository = token<PetsRepository>(Symbol.for('pets.repository'))

@Injectable(kPetsRepository)
export class PetsInMemoryRepository implements PetsRepository {
  private readonly pets: Pet[] = []
  private seq = 1

  all(): Pet[] {
    return this.pets
  }

  byID(id: number): Pet | undefined {
    return this.pets.find(p => p.id === id)
  }

  create(pet: Pet): Pet {
    const newPet = { ...pet, id: this.seq++ }
    this.pets.push(newPet)
    return newPet
  }

  update(id: number, pet: Pet): Pet | undefined {
    const index = this.pets.findIndex(p => p.id === id)
    if (index === -1) {
      return undefined
    }
    this.pets[index] = pet
    return pet
  }

  delete(id: number): boolean {
    const index = this.pets.findIndex(p => p.id === id)
    if (index === -1) {
      return false
    }
    this.pets.splice(index, 1)
    return true
  }
}
