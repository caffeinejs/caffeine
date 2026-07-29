import { Ctor } from '../../../types.js'

export function isConstructable<T>(value: unknown): value is Ctor<T> {
  return typeof value === 'function' && value.prototype !== undefined && value.prototype.constructor === value
}
