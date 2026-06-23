/**
 * Composes multiple decorators of the same kind into a single decorator.
 *
 * Applies decorators left-to-right.
 *
 * @example
 * ```ts
 * const AppComponent = composeDecorators(Singleton(), Injectable())
 *
 * @AppComponent
 * class UserService {}
 * ```
 *
 * @remarks
 * Requires `experimentalDecorators: true` in `tsconfig.json`.
 */
export function composeDecorators(
  ...decorators: Array<
    (target: object | Function, propertyKey?: string | symbol, descriptor?: PropertyDescriptor) => void
  >
): (target: object | Function, propertyKey?: string | symbol, descriptor?: PropertyDescriptor) => void {
  return (target: object | Function, propertyKey?: string | symbol, descriptor?: PropertyDescriptor) => {
    for (const dec of decorators) {
      dec(target, propertyKey, descriptor)
    }
  }
}
