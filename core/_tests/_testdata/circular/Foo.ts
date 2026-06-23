import { randomUUID } from 'node:crypto'
import { Injectable } from '../../../decorators/injectable.js'
import { defer } from '../../../injection.js'
import { Scopes } from '../../../scope.js'
import { Lifetime } from '../../../decorators/lifetime.js'
import { Bar, BarTransient } from './Bar.js'

@Injectable([defer(() => Bar)])
export class Foo {
  uuid: string = randomUUID()

  constructor(readonly bar: Bar) {}

  id = () => 'foo'

  test(): string {
    return `foo-${this.bar.id()}`
  }
}

@Injectable([defer(() => BarTransient)])
@Lifetime(Scopes.TRANSIENT)
export class FooTransient {
  uuid: string = randomUUID()

  constructor(readonly bar: BarTransient) {}

  id = () => 'foo'

  test(): string {
    return `foo-${this.bar.id()}`
  }
}
