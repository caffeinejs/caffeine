import { CaffeineIoC, type Module, type ModuleFn } from '@caffeinejs/di'

/**
 * Builds the application IoC container from the module graph it is given.
 *
 * Returned uninitialized — `WebApplication.ready()` (or a `TestContainer` in tests) initializes it. The root
 * module is a parameter rather than something this file imports, so a test can hand over one feature's module
 * instead of the whole graph, and so nothing here depends on generated code.
 */
export function createContainer(...modules: Array<Module | ModuleFn>): CaffeineIoC {
  return new CaffeineIoC({ modules })
}
