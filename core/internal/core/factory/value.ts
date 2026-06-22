import { Factory } from '../../../factory.js'
import { ResolutionContext } from '../../../resolution_context.js'

export function valueFactory<T = any>(value: T): Factory<T> {
  return (_ctx: ResolutionContext): T => value
}
