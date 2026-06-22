import { Injectable } from '../../../decorators/injectable.js'
import { BarFail } from './BarFail.js'

@Injectable()
export class FooFail {
  bar!: BarFail

  id = () => 'foo'

  test(): string {
    return `foo-${this.bar.id()}`
  }
}
