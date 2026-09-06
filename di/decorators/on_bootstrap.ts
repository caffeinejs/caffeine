import { getInjectionMetadata } from './registrar/index.js'

/**
 * Marks a method to be called automatically by init(), after every binding has been resolved.
 * Bootstrap methods can be asynchronous.
 *
 * @example
 * ```ts
 * @Injectable()
 * class CacheWarmer {
 *   @OnBootstrap()
 *   async warm() {
 *     await this.load()
 *   }
 * }
 * ```
 */
export function OnBootstrap() {
  return function (_target: Object, context: ClassMemberDecoratorContext) {
    getInjectionMetadata(context.metadata).bootstrap(context.name)
  }
}
