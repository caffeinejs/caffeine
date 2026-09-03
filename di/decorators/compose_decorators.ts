/**
 * Composes multiple decorators of the same kind into a single decorator.
 *
 * Applies decorators left-to-right. For field decorators, chains initializer functions in order.
 *
 * @example
 * ```ts
 * const AppComponent = composeDecorators(Singleton(), Injectable())
 *
 * @AppComponent
 * class UserService {}
 * ```
 */
export function composeDecorators<T extends abstract new (...args: any) => any>(
  ...decorators: Array<(target: T, context: ClassDecoratorContext) => T | void>
): (target: T, context: ClassDecoratorContext) => T | void

export function composeDecorators<This, Value extends (this: This, ...args: any) => any>(
  ...decorators: Array<(target: Value, context: ClassMethodDecoratorContext<This, Value>) => Value | void>
): (target: Value, context: ClassMethodDecoratorContext<This, Value>) => Value | void

export function composeDecorators<This, Value>(
  ...decorators: Array<
    (target: undefined, context: ClassFieldDecoratorContext<This, Value>) => ((v: Value) => Value) | void
  >
): (target: undefined, context: ClassFieldDecoratorContext<This, Value>) => ((v: Value) => Value) | void

export function composeDecorators<This, Value>(
  ...decorators: Array<(target: () => Value, context: ClassGetterDecoratorContext<This, Value>) => (() => Value) | void>
): (target: () => Value, context: ClassGetterDecoratorContext<This, Value>) => (() => Value) | void

export function composeDecorators<This, Value>(
  ...decorators: Array<
    (target: (v: Value) => void, context: ClassSetterDecoratorContext<This, Value>) => ((v: Value) => void) | void
  >
): (target: (v: Value) => void, context: ClassSetterDecoratorContext<This, Value>) => ((v: Value) => void) | void

export function composeDecorators<This, Value>(
  ...decorators: Array<
    (
      target: ClassAccessorDecoratorTarget<This, Value>,
      context: ClassAccessorDecoratorContext<This, Value>,
    ) => ClassAccessorDecoratorResult<This, Value> | void
  >
): (
  target: ClassAccessorDecoratorTarget<This, Value>,
  context: ClassAccessorDecoratorContext<This, Value>,
) => ClassAccessorDecoratorResult<This, Value> | void

export function composeDecorators(
  ...decorators: Array<(target: any, context: any) => any>
): (target: any, context: any) => any {
  return (target: any, context: any) => {
    if (context.kind === 'field') {
      const initializers = decorators.map(dec => dec(undefined, context)).filter(Boolean)
      return initializers.length === 0 ? undefined : (v: any) => initializers.reduce((acc, fn) => fn(acc), v)
    }
    let current = target
    for (const dec of decorators) {
      current = dec(current, context) ?? current
    }
    return current !== target ? current : undefined
  }
}
