import { randomUUID } from 'node:crypto'
import { Injectable } from '../../../decorators/injectable.js'
import { Lifetime } from '../../../decorators/lifetime.js'
import { Scopes } from '../../../scope.js'
import { defer } from '../../../injection.js'
import { Foo, FooTransient } from './Foo.js'

@Injectable([defer(() => Foo)])
export class Bar {
  uuid: string = randomUUID()

  constructor(readonly foo: Foo) {}

  id = () => 'bar'

  test(): string {
    return `bar-${this.foo.id()}`
  }
}

@Injectable([defer(() => FooTransient)])
@Lifetime(Scopes.TRANSIENT)
export class BarTransient {
  uuid: string = randomUUID()

  constructor(readonly foo: FooTransient) {}

  id = () => 'bar'

  test(): string {
    return `bar-${this.foo.id()}`
  }
}
