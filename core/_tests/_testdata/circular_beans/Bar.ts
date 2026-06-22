import { v4 } from 'uuid'
import { Foo } from './Foo.js'

export class Bar {
  uuid: string = v4()

  constructor(readonly foo: Foo) {}

  id = () => 'bar'

  test(): string {
    return `bar-${this.foo.id()}`
  }
}
