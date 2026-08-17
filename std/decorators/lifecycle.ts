import { type ApplicationEvent, recordHook } from './lifecycle_registry.js'

function lifecycleDecorator(event: ApplicationEvent) {
  return function () {
    return function (_target: Function, context: ClassMethodDecoratorContext): void {
      recordHook(context.metadata, event, context.name)
    }
  }
}

/**
 * Marks a method to run when the application is ready — after the container is initialized and the app is
 * wired, before it starts serving. Fires on singleton beans only.
 *
 * ```ts
 * @Injectable()
 * class Warmup {
 *   @OnApplicationReady()
 *   async load() { await this.cache.warm() }
 * }
 * ```
 */
export const OnApplicationReady = lifecycleDecorator('application:ready')

/** Marks a method to run just before the application starts serving — after ready, ahead of the server. */
export const OnApplicationRun = lifecycleDecorator('application:run')

/** Marks a method to run at the very start of shutdown, before the application tears down. Best-effort. */
export const OnPreApplicationShutdown = lifecycleDecorator('application:pre-shutdown')

/** Marks a method to run during shutdown, before the container is disposed. Best-effort. */
export const OnApplicationShutdown = lifecycleDecorator('application:shutdown')
