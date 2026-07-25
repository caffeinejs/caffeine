import { Controller } from '../util/decorators/controller.js'
import { Delete } from '../util/decorators/delete.js'
import { Get } from '../util/decorators/get.js'
import { Body, Params, Path } from '../util/decorators/params.js'
import { Post } from '../util/decorators/post.js'
import { Put } from '../util/decorators/put.js'
import { Pet } from './pets.js'
import { PetsRepository } from './pets.repo.js'

@Controller('/pets', [Symbol.for('pets.repository')])
export class PetsController {
  constructor(private readonly petsRepository: PetsRepository) {}

  @Get('')
  all() {
    return this.petsRepository.all()
  }

  @Post('')
  @Params([Body()])
  create(pet: Pet) {
    return this.petsRepository.create(pet)
  }

  @Get(':id')
  @Params([Path('id')])
  byID(id: string) {
    return this.petsRepository.byID(Number(id))
  }

  @Put(':id')
  @Params([Path('id'), Body()])
  update(id: string, pet: Pet) {
    return this.petsRepository.update(Number(id), pet)
  }

  @Delete(':id')
  @Params([Path('id')])
  delete(id: string) {
    return this.petsRepository.delete(Number(id))
  }
}
