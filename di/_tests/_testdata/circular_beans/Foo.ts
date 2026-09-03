import { randomUUID } from 'node:crypto'

import { Bar } from './Bar.js'

export class Foo {
  uuid: string = randomUUID()

  constructor(readonly bar: Bar) {}

  id = () => 'foo'

  test(): string {
    return `foo-${this.bar.id()}`
  }
}
