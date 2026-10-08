import { ErrInvalidDecorator } from '../errors.js'
import { errMessage } from '../internal/util/errutil/index.js'
import { AbstractCtor, Ctor } from '../types.js'
import { defineInjectable, getBindingConfiguration } from './registrar/index.js'

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
 */
export function Extends<T>(
  base: Ctor<T> | AbstractCtor<T>,
): <TFunction extends Ctor>(target: TFunction, context: ClassDecoratorContext) => void
export function Extends(): <TFunction extends Ctor>(target: TFunction, context: ClassDecoratorContext) => void
export function Extends<T>(base?: Ctor<T> | AbstractCtor<T>) {
  if (base !== undefined && typeof base !== 'function') {
    throw new ErrInvalidDecorator(
      errMessage(`@${Extends.name}(): parameter base must be a class reference (typeof 'function')`)
        .reference('@caffeinejs/di', ErrInvalidDecorator)
        .build(),
    )
  }

  return function <TFunction extends Ctor>(target: TFunction, context: ClassDecoratorContext) {
    const parent = Object.getPrototypeOf(target)

    if (base === undefined && parent === Function.prototype) {
      throw new ErrInvalidDecorator(
        errMessage(
          `Cannot apply @${Extends.name} to "${target.name}": "${target.name}" does not explicitly extend a class`,
        )
          .reference('@caffeinejs/di', ErrInvalidDecorator)
          .build(),
      )
    }

    if (base !== undefined && !(target.prototype instanceof base)) {
      throw new ErrInvalidDecorator(
        errMessage(
          `Cannot apply @${Extends.name} to "${target.name}": "${target.name}" does not extend "${(base as AbstractCtor).name}"`,
        )
          .reference('@caffeinejs/di', ErrInvalidDecorator)
          .build(),
      )
    }

    const existing = getBindingConfiguration(target)

    if (existing && (existing.keysProvided?.length ?? 0) > 0 && !existing.configuration) {
      throw new ErrInvalidDecorator(
        errMessage(
          `Cannot apply @${Extends.name} to "${target.name}": @${Extends.name} is already declared on this class`,
        )
          .reference('@caffeinejs/di', ErrInvalidDecorator)
          .build(),
      )
    }

    const resolvedBase = (base ?? parent) as Ctor | AbstractCtor

    defineInjectable(context.metadata, target, config => config.extend(resolvedBase))
  }
}
