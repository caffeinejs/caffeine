import { getInjectionMetadata } from './registrar/index.js'

/**
 * Marks a method to be called after the component is constructed and all dependencies are injected.
 * Post-construct methods must always be synchronous.
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
 */
export function PostConstruct() {
  return function (_target: Object, context: ClassMemberDecoratorContext) {
    getInjectionMetadata(context.metadata).postConstruct(context.name)
  }
}
