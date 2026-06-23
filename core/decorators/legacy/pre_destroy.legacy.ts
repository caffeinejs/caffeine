import { getLegacyInjectionMetadata } from '../registrar/index.js'

/**
 * Marks a method to be called before the component is destroyed or the container is disposed.
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
 *
 * @remarks
 * Requires `experimentalDecorators: true` in `tsconfig.json`.
 */
export function PreDestroy() {
  return function (target: object, propertyKey: string | symbol) {
    getLegacyInjectionMetadata(target).preDestroy(propertyKey)
  }
}
