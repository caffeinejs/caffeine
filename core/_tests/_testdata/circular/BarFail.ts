import { Injectable } from '../../../decorators/injectable.js'
import { FooFail } from './FooFail.js'

@Injectable([FooFail])
export class BarFail {
  constructor(readonly foo: FooFail) {}

  id = () => 'bar'

  test(): string {
    return `bar-${this.foo.id()}`
  }
}
