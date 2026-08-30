/**
 * CaffeineIoC - Fast and Powerful Dependency Injection Container for JS/TS.
 *
 * @packageDocumentation
 */

import './_polyfill.js'

export { annotate, createAnnotation } from './annotations.js'
export type { JoinPoint, MethodAspect, Pointcut, PointcutClassPredicate, PointcutMethodPredicate } from './aop.js'
export { $aop } from './aop.js'
export type { AOPBinder } from './aop_binder.js'
export type { AOPBinderOptions } from './aop_binder_options.js'
export type { Binder } from './binder.js'
export type { BinderOptions } from './binder_options.js'
export type { Binding } from './binding.js'
export type { Conditional, ConditionContext } from './conditional.js'
export { CaffeineIoC } from './container.js'
export type * from './container_interface.js'
export * from './decorators/index.js'
export { DeferredCtor } from './deferred_ctor.js'
export * from './errors.js'
export type { AsyncFactory, Factory } from './factory.js'
export type { BindingGraph, EdgeKind, GraphEdge, GraphNode } from './graph.js'
export { buildBindingGraph, graphToDot, graphToJSON, graphToMarkdown, graphToMermaid, graphToText } from './graph.js'
export type * from './hooks.js'
export * from './injection.js'
export {
  bindResolver,
  BuiltInResolvers,
  hasResolver,
  type InjectionResolver,
  type InjectionResolverFactory,
  type InjectionResolverFactoryContext,
  unbindResolver,
} from './injection_resolver.js'
export {
  type Identifier,
  type InjectionToken,
  type NamedToken,
  token,
  type TokenBrand,
  type TypedKey,
} from './key.js'
export type { MetadataReader } from './metadata_reader.js'
export { kModule, mod, type Module, type ModuleFn } from './module.js'
export type { PostProcessor } from './post_processor.js'
export type { PostResolutionInterceptor } from './post_resolution_interceptor.js'
export type { Provider } from './provider.js'
export { defineMetadata, getMetadata, getMetadataOverride, reflect } from './reflect.js'
export type { Refresher, SelfRefreshable } from './refresher.js'
export { kSelfRefresh } from './refresher.js'
export type { ResolutionContext } from './resolution_context.js'
export { bindScope, hasScope, type Scope, type ScopeFactory, Scopes, unbindScope } from './scope.js'
export type { Snapshot } from './snapshot.js'
export * from './symbols.js'
export type * from './types.js'
