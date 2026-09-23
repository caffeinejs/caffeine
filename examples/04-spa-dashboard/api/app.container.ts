import { CaffeineIoC, type Module, type ModuleFn } from '@caffeinejs/di'

/**
 * Builds the application IoC container from the module graph it is given.
 *
 * Returned uninitialized — `WebApplication.ready()` (or a `TestContainer`) initializes it. The root module is
 * a parameter rather than something this file imports, so nothing here depends on generated code.
 */
export function createContainer(...modules: Array<Module | ModuleFn>): CaffeineIoC {
  return new CaffeineIoC({ modules })
}
