/**
 * CaffeineIoC - Fast and Powerful Dependency Injection Container for JS/TS.
 *
 * @packageDocumentation
 */

export { createAnnotation } from './annotations.js'
export type { JoinPoint, MethodAspect, Pointcut, PointcutClassPredicate, PointcutMethodPredicate } from './aop.js'
export { $aop } from './aop.js'
export type { AspectSpec } from './aspect_spec.js'
export type { Binding } from './binding.js'
export type { BindingSpec } from './binding_spec.js'
export { $cond, type Condition, type ConditionHelpers, type Conditions } from './conditional.js'
export { CaffeineIoC } from './container.js'
export type * from './container_interface.js'
export * from './decorators/index.js'
export { DeferredCtor } from './deferred_ctor.js'
export * from './errors.js'
export type { AsyncFactory, Factory } from './factory.js'
export type * from './hooks.js'
export * from './injection.js'
export {
  bindResolver,
  BuiltInStages,
  hasResolver,
  hasStage,
  type InjectionContext,
  type InjectionMiddleware,
  type InjectionResolver,
  type InjectionResolverFactory,
  type InjectionResolverFactoryContext,
  registerStage,
  unbindResolver,
  unregisterStage,
} from './injection_resolver.js'
export {
  type Identifier,
  type InjectionToken,
  isValidKey,
  type NamedToken,
  token,
  type TokenBrand,
  type TokenValue,
  type TypedKey,
} from './key.js'
export type { OnBootstrap, OnDestroy } from './lifecycle.js'
export { kModule, mod, type Module, type ModuleFn } from './module.js'
export type { PostProcessor } from './post_processor.js'
export type { PostResolutionInterceptor } from './post_resolution_interceptor.js'
export type { Provider } from './provider.js'
export { type Annotation, type AnnotationTarget, reflect } from './reflect.js'
export type { Refresher, SelfRefreshable } from './refresher.js'
export { kSelfRefresh } from './refresher.js'
export type { ResolutionContext } from './resolution_context.js'
export { bindScope, hasScope, type Scope, type ScopeFactory, Scopes, unbindScope } from './scope.js'
export { type Declaration, Snapshot, type SnapshotState } from './snapshot.js'
export * from './symbols.js'
export type * from './types.js'
