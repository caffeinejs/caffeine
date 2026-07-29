import { getInjectionMetadata } from './registrar/index.js'

/**
 * Marks a method to be called before the component is destroyed or the container is disposed.
 * Pre-destroy methods can be asynchronous.
 *
 * @example
 * ```ts
 * @Injectable()
 * class ConnectionPool {
 *   @PreDestroy()
 *   close() {
 *     this.pool.end()
 *   }
 * }
 * ```
 */
export function PreDestroy() {
  return function (_target: Function, context: ClassMethodDecoratorContext) {
    getInjectionMetadata(context.metadata).preDestroy(context.name)
  }
}
