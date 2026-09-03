import { randomUUID } from 'node:crypto'

import { Injectable } from '../../../decorators/injectable.js'
import { Lifetime } from '../../../decorators/lifetime.js'
import { $i } from '../../../injection.js'
import { Scopes } from '../../../scope.js'
import { Bar, BarTransient } from './Bar.js'

@Injectable([$i.defer(() => Bar)])
export class Foo {
  uuid: string = randomUUID()

  constructor(readonly bar: Bar) {}

  id = () => 'foo'

  test(): string {
    return `foo-${this.bar.id()}`
  }
}

@Injectable([$i.defer(() => BarTransient)])
@Lifetime(Scopes.TRANSIENT)
export class FooTransient {
  uuid: string = randomUUID()

  constructor(readonly bar: BarTransient) {}

  id = () => 'foo'

  test(): string {
    return `foo-${this.bar.id()}`
  }
}
