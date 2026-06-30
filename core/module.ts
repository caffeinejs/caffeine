import { Container, ContainerBindingOps } from './container_interface.js'

const kName = Symbol('@caffeinejs/core:module.name')
export const kModule = Symbol('@caffeinejs/core:module')

/**
 * Module can be used to register bindings within a {@link Container} instance in a modular way.
 * Modules can be used to organize binding registrations within their own modules.
 * @example
 * - order
 *  - order.mod.ts
 * - users
 *  - users.mod.ts
 *
 * order.mod.ts
 * ```ts
 * export function orderModule(container: Container) => {
 *   container.bind(OrderProcessor).toSelf()
 * }
 * ```
 *
 * ```ts
 * import { orderModule } from './order.mod.js'
 * import { usersModule } from './users.mod.js'
 *
 * const container = new CaffeineIoC([orderModule, usersModule])
 * await container.init()
 * ```
 */
export type Module
  = | ((container: ContainerBindingOps) => void)
    | ((container: ContainerBindingOps) => Promise<void>)

/**
 * mod is a helper function that allows naming a module.
 * It is useful when you want to name a module for debugging purposes.
 *
 * @example
 * ```ts
 * const orderModule = mod('order', (container: ContainerBindingOps) => {
 *   container.bind(OrderProcessor).toSelf()
 * })
 * ```
 *
 * @param name - The name of the module.
 * @param fn - The module function.
 *
 * @returns The original module function named.
 */
export function mod(name: string, fn: Module): Module {
  ; (fn as any)[kName] = name
  ; (fn as any)[kModule] = true
  return fn
}

export async function runModule(module: Module, container: Container, index: number): Promise<void> {
  let name = moduleName(module)
  if (!name) {
    name = `module at index ${index}`
  }

  let result: void | Promise<void>
  try {
    result = module(container)
  } catch (error) {
    container.hooks.emit('onModuleRegistrationFailed', { name, index, error: error as Error })
    throw error
  }

  return Promise
    .resolve(result)
    .then(() => {
      container.hooks.emit('onModuleRegistered', { name, index })
    })
    .catch(error => {
      container.hooks.emit('onModuleRegistrationFailed', { name, index, error })
      throw error
    })
}

function moduleName(fn: Module): string {
  return (fn as any)[kName] ?? fn.name ?? ''
}
