import { randomUUID } from 'node:crypto'
import { Foo } from './Foo.js'

export class Bar {
  uuid: string = randomUUID()

  constructor(readonly foo: Foo) {}

  id = () => 'bar'

  test(): string {
    return `bar-${this.foo.id()}`
  }
}
