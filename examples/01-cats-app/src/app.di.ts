import { CaffeineIoC } from '@caffeinejs/di'

// Builds the application IoC container. Returned uninitialized — WebApplication.ready() (or a
// TestContainer in tests) initializes it.
export async function createContainer(): Promise<CaffeineIoC> {
  const { rootModule } = await import('./root.gen.mod.js')

  return new CaffeineIoC({ modules: [rootModule] })
}
