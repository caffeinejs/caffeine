import { getLegacyInjectionMetadata } from '../registrar/index.js'

/**
 * Marks a method to be called after the component is constructed and all dependencies are injected.
 *
 * @example
 * ```ts
 * @Injectable()
 * class CacheService {
 *   @PostConstruct()
 *   init() {
 *     this.load()
 *   }
 * }
 * ```
 *
 * @remarks
 * Requires `experimentalDecorators: true` in `tsconfig.json`.
 */
export function PostConstruct() {
  return function (target: object, propertyKey: string | symbol) {
    getLegacyInjectionMetadata(target).postConstruct(propertyKey)
  }
}
