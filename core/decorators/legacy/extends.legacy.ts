import { check } from '../../internal/util/assert/index.js'
import { ErrInvalidDecorator } from '../../errors.js'
import { AbstractCtor, Ctor } from '../../types.js'
import { defineInjectable, getBindingConfiguration } from '../registrar/index.js'

/**
 * Binds a class to a base or abstract class so it can be resolved by that type.
 *
 * Omit `base` to use the direct superclass automatically.
 *
 * @param base - Abstract or base class to register as. Defaults to direct superclass.
 *
 * @example
 * ```ts
 * abstract class Logger {}
 *
 * @Extends(Logger)
 * @Injectable()
 * class ConsoleLogger extends Logger {}
 * ```
 *
 * @remarks
 * Requires `experimentalDecorators: true` in `tsconfig.json`.
 */
export function Extends<T>(base: Ctor<T> | AbstractCtor<T>): (target: Function) => void
export function Extends(): (target: Function) => void
export function Extends<T>(base?: Ctor<T> | AbstractCtor<T>) {
  if (base !== undefined) {
    check(
      typeof base === 'function',
      `@${Extends.name}(): parameter base must be a class reference (typeof 'function')`,
    )
  }

  return function (target: Function) {
    const parent = Object.getPrototypeOf(target)

    if (base === undefined && parent === Function.prototype) {
      throw new ErrInvalidDecorator(
        `Cannot apply @${Extends.name} to "${(target as Ctor).name}": "${(target as Ctor).name}" does not explicitly extend a class`,
      )
    }

    if (base !== undefined && !(target.prototype instanceof base)) {
      throw new ErrInvalidDecorator(
        `Cannot apply @${Extends.name} to "${(target as Ctor).name}": "${(target as Ctor).name}" does not extend "${(base as AbstractCtor).name}"`,
      )
    }

    const existing = getBindingConfiguration(target as Ctor)

    if (existing && (existing.keysProvided?.length ?? 0) > 0 && !existing.configuration) {
      throw new ErrInvalidDecorator(
        `Cannot apply @${Extends.name} to "${(target as Ctor).name}": @${Extends.name} is already declared on this class`,
      )
    }

    const resolvedBase = (base ?? parent) as Ctor | AbstractCtor

    defineInjectable(target, target as Ctor<T>, config => config.extend(resolvedBase))
  }
}
