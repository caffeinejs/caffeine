import { CaffeineIoC, type Module, type ModuleFn } from '@caffeinejs/di'

// Builds the application IoC container. Returned uninitialized — WebApplication.ready() (or a
// TestContainer in tests) initializes it. Omit `modules` to load the generated root graph.
export async function createContainer(modules?: Array<Module | ModuleFn>): Promise<CaffeineIoC> {
  if (modules !== undefined) {
    return new CaffeineIoC({ modules })
  }

  const { rootModule } = await import('./root.generated.mod.js')

  return new CaffeineIoC({ modules: [rootModule] })
}
