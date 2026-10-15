import { Get } from './verbs.js'

/**
 * A verb decorator takes a method only when its return type, declared or inferred, is assignable to `ActionResult`.
 * Nothing at run time checks it, so this file is what holds it: `npm run test:typecheck` is the test.
 */

interface Pet {
  id: string
  name: string
}

declare class PetService {
  find(id: string): Pet | undefined
  findOrNull(id: string): Pet | null
  list(): Pet[]
  count(): number
  exists(id: string): boolean
  nameOf(id: string): string
  listAsync(): Promise<Pet[]>
  untyped(): unknown
}

class Annotated {
  @Get('/number')
  returnsNumber(): number {
    return 0
  }

  @Get('/boolean')
  returnsBoolean(): boolean {
    return false
  }

  @Get('/null')
  returnsNull(): null {
    return null
  }

  @Get('/string')
  returnsString(): string {
    return ''
  }

  @Get('/void')
  returnsVoid(): void {}

  @Get('/object')
  returnsObject(): { ok: boolean } {
    return { ok: true }
  }

  @Get('/async/number')
  async resolvesNumber(): Promise<number> {
    return 0
  }

  @Get('/async/boolean')
  async resolvesBoolean(): Promise<boolean> {
    return false
  }

  @Get('/async/null')
  async resolvesNull(): Promise<null> {
    return null
  }

  @Get('/async/string')
  async resolvesString(): Promise<string> {
    return ''
  }

  @Get('/async/void')
  async resolvesVoid(): Promise<void> {}

  @Get('/async/object')
  async resolvesObject(): Promise<{ ok: boolean }> {
    return { ok: true }
  }

  // Parameters are not checked, only the return type.
  @Get('/:id')
  withParameters(id: string, limit: number): { id: string; limit: number } {
    return { id, limit }
  }
}

// Nothing here is annotated or cast: what each handler returns is inferred from the service.
class Inferred {
  constructor(private readonly service: PetService) {}

  @Get('/pets/:id')
  find(id: string) {
    return this.service.find(id)
  }

  @Get('/pets/:id/or-null')
  findOrNull(id: string) {
    return this.service.findOrNull(id)
  }

  @Get('/pets')
  list() {
    return this.service.list()
  }

  @Get('/pets/count')
  count() {
    return this.service.count()
  }

  @Get('/pets/:id/exists')
  exists(id: string) {
    return this.service.exists(id)
  }

  @Get('/pets/:id/name')
  nameOf(id: string) {
    return this.service.nameOf(id)
  }

  @Get('/pets/async')
  listAsync() {
    return this.service.listAsync()
  }

  @Get('/pets/:id/awaited')
  async awaited(id: string) {
    const pets = await this.service.listAsync()
    return pets.find(pet => pet.id === id) ?? null
  }
}

class Rejected {
  constructor(private readonly service: PetService) {}

  // @ts-expect-error a symbol is not an ActionResult
  @Get('/symbol')
  returnsSymbol(): symbol {
    return Symbol('result')
  }

  // @ts-expect-error unknown is not an ActionResult
  @Get('/unknown')
  returnsUnknown(): unknown {
    return 0
  }

  // @ts-expect-error an inferred unknown is not an ActionResult
  @Get('/untyped')
  untyped() {
    return this.service.untyped()
  }
}

void [Annotated, Inferred, Rejected]
