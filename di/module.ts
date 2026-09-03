import type { Container, ContainerBindingOps } from './container_interface.js'
import type { Ctor } from './types.js'

export const kModule = Symbol('@caffeinejs/di:module')

export type ModuleFn = ((container: ContainerBindingOps) => void) | ((container: ContainerBindingOps) => Promise<void>)

/**
 * Module organizes binding registrations for a {@link Container}.
 *
 * `needs` and `provides` are optional thunks. Omit them when there is nothing
 * to list. When present, they are called at collect time so circular ESM
 * imports do not read a sibling module while its file is still evaluating.
 *
 * @example
 * ```ts
 * import { userModule } from './user.mod.js'
 *
 * export const orderModule = mod({
 *   name: 'order',
 *   needs: () => [userModule],
 *   provides: () => [OrderController],
 *   fn: container => {
 *     container.bind(OrderProcessor).toSelf()
 *   },
 * })
 *
 * const container = new CaffeineIoC({ modules: [orderModule] })
 * await container.init()
 * ```
 */
export interface Module {
  name: string
  needs?: () => Module[]
  provides?: () => Array<Ctor | Module>
  fn?: ModuleFn
}

/**
 * Builds a {@link Module} object.
 *
 * `mod(name, fn)` wraps a registration function.
 * `mod(module)` stamps an existing object without calling `needs` or `provides`.
 *
 * @example
 * ```ts
 * const orderModule = mod('order', (container: ContainerBindingOps) => {
 *   container.bind(OrderProcessor).toSelf()
 * })
 * ```
 */
export function mod(name: string, fn: ModuleFn): Module
export function mod(module: Module): Module
export function mod(nameOrModule: string | Module, fn?: ModuleFn): Module {
  if (typeof nameOrModule !== 'string') {
    return stamp(nameOrModule)
  }

  return stamp({
    name: nameOrModule,
    fn,
  })
}

export async function runModules(roots: Array<Module | ModuleFn>, container: Container): Promise<void> {
  const ordered = collectModules(roots)
  for (let index = 0; index < ordered.length; index++) {
    await runModule(ordered[index], container, index)
  }
}

async function runModule(module: Module, container: Container, index: number): Promise<void> {
  const name = module.name || `module at index ${index}`

  if (!module.fn) {
    container.hooks.emit('onModuleRegistered', { name, index })
    return
  }

  let result: void | Promise<void>
  try {
    result = module.fn(container)
  } catch (error) {
    container.hooks.emit('onModuleRegistrationFailed', { name, index, error: error as Error })
    throw error
  }

  return Promise.resolve(result)
    .then(() => {
      container.hooks.emit('onModuleRegistered', { name, index })
    })
    .catch(error => {
      container.hooks.emit('onModuleRegistrationFailed', { name, index, error })
      throw error
    })
}

function normalizeModule(input: Module | ModuleFn): Module {
  if (typeof input === 'function') {
    return {
      name: input.name || '',
      fn: input,
    }
  }

  return input
}

function isNestedModule(item: Ctor | Module): item is Module {
  return typeof item === 'object' && item !== null
}

function collectModules(roots: Array<Module | ModuleFn>): Module[] {
  const queued = new Set<ModuleFn | Module>()
  const path = new Set<ModuleFn | Module>()
  const order: Module[] = []
  const stack: Array<{ input: Module | ModuleFn; module?: Module; phase: 'enter' | 'exit' }> = []

  for (let i = roots.length - 1; i >= 0; i--) {
    stack.push({ input: roots[i], phase: 'enter' })
  }

  while (stack.length > 0) {
    const frame = stack.pop()!
    if (frame.phase === 'exit') {
      const module = frame.module!
      const key = module.fn ?? module
      path.delete(key)
      queued.add(key)
      order.push(module)
      continue
    }

    const module = normalizeModule(frame.input)
    const key = module.fn ?? module

    if (queued.has(key) || path.has(key)) {
      continue
    }

    path.add(key)
    stack.push({ input: frame.input, module, phase: 'exit' })

    const children: Array<Module | ModuleFn> = []
    for (const dep of module.needs?.() ?? []) {
      children.push(dep)
    }
    for (const item of module.provides?.() ?? []) {
      if (isNestedModule(item)) {
        children.push(item)
      }
    }
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ input: children[i], phase: 'enter' })
    }
  }

  return order
}

function stamp(module: Module): Module {
  ;(module as Module & { [kModule]: true })[kModule] = true
  return module
}
