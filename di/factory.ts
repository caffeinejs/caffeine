import { Binding } from './binding.js'
import { ContainerOps } from './container_interface.js'
import { InjectionToken } from './key.js'
import { ResolutionContext } from './resolution_context.js'

/**
 * Factory is a function that creates an instance.
 */
export type Factory<T = unknown> = (ctx: ResolutionContext) => T

/**
 * AsyncFactory is a function that creates an instance asynchronously.
 * Async provided bindings are constrained to be only either singleton or refresh scoped.
 * Also, they are eagerly instantiated during the container initialization always.
 */
export type AsyncFactory<T = unknown> = Factory<Promise<T>>

/**
 * FactoryCreator is a function that creates a factory for a given key and binding.
 * Useful when you need to pre-process operations to optimize the factory.
 */
export type FactoryCreator<T = unknown> = (key: InjectionToken<T>, binding: Binding<T>, container: ContainerOps) => Factory<T>
