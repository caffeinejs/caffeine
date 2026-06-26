/**
 * CaffeineIoC - Fast and Powerful Dependency Injection Container for JS/TS.
 *
 * @packageDocumentation
 */

export type { Binder } from './binder.js'
export type { BinderOptions } from './binder_options.js'
export type { Binding } from './binding.js'
export type { Conditional, ConditionContext } from './conditional.js'
export { CaffeineIoC } from './container.js'
export type * from './container_interface.js'
export * from './errors.js'
export type { AsyncFactory, Factory } from './factory.js'
export type { BindingGraph, EdgeKind, GraphEdge, GraphNode } from './graph.js'
export { buildBindingGraph, graphToDot, graphToJson, graphToMarkdown, graphToMermaid, graphToText } from './graph.js'
export type * from './hooks.js'
export * from './injection.js'
export * as inject from './injection.js'
export {
  bindResolver,
  BuiltInResolvers,
  hasResolver,
  type InjectionResolver,
  type InjectionResolverFactory,
  type InjectionResolverFactoryContext,
  unbindResolver,
} from './injection_resolver.js'
export type { Identifier, Key } from './key.js'
export type { MetadataReader } from './metadata_reader.js'
export { mod, type Module } from './module.js'
export type { PostProcessor } from './post_processor.js'
export type { PostResolutionInterceptor } from './post_resolution_interceptor.js'
export type { Provider } from './provider.js'
export type * from './refresher.js'
export type { ResolutionContext } from './resolution_context.js'
export { bindScope, hasScope, type Scope, type ScopeFactory, Scopes, unbindScope } from './scope.js'
export type { Snapshot } from './snapshot.js'
export * from './symbols.js'
export type * from './types.js'
