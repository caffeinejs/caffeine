import { errMessage } from './internal/util/errutil/index.js'
import { keyStr, InjectionToken, Identifier } from './key.js'
import { Ctor } from './types.js'

/**
 * CaffeineIoCError is the base error class for all errors thrown by the CaffeineIoC library.
 */
export class CaffeineIoCError extends Error {
  readonly code: string

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

/**
 * ErrNoUniqueInjectionForKey is an error that is thrown when requesting a single instance of a key
 * that has more than one injectable bound to it, without a disambiguation strategy.
 */
export class ErrNoUniqueInjectionForKey extends CaffeineIoCError {
  constructor(key: InjectionToken, message?: string) {
    super(
      errMessage(
        message ?? `Found more than one component bound to the key "${keyStr(key)}" when a single one was expected`,
      )
        .solutions(
          `Use allOf(key) if you want to inject multiple instances bound to the key "${keyStr(key)}"`,
          `Use @Named providing a name to differentiate injectables and inject the dependency using it`,
          `Use @Primary to specify an unique injectable`,
          `Use @Conditional to register injectables only when their conditions pass, leaving one for the given key`,
        )
        .reference('@caffeinejs/di', ErrNoUniqueInjectionForKey)
        .build(),
      'ERR_NO_UNIQUE_INJECTION',
    )
    this.name = 'ErrNoUniqueInjectionForKey'
  }
}

/**
 * ErrNoResolutionForKey is an error that is thrown when no resolution is found for a key.
 */
export class ErrNoResolutionForKey extends CaffeineIoCError {
  constructor(message: string) {
    super(message, 'ERR_NO_RESOLUTION_FOR_KEY')
    this.name = 'ErrNoResolutionForKey'
  }
}

/**
 * ErrScopeNotRegistered is an error that is thrown when binding to a scope that is not registered.
 */
export class ErrScopeNotRegistered extends CaffeineIoCError {
  constructor(scopeID: Identifier) {
    super(
      errMessage(`Scope "${scopeID.toString()}" is not registered: use bindScope() to register it`)
        .reference('@caffeinejs/di', ErrScopeNotRegistered)
        .build(),
      'ERR_SCOPE_NOT_REGISTERED',
    )
    this.name = 'ErrScopeNotRegistered'
  }
}

/**
 * ErrScopeAlreadyRegistered is an error that is thrown when binding to a scope that is already registered.
 */
export class ErrScopeAlreadyRegistered extends CaffeineIoCError {
  constructor(scopeID: Identifier) {
    super(
      errMessage(`Scope "${scopeID.toString()}" is already registered`)
        .reference('@caffeinejs/di', ErrScopeAlreadyRegistered)
        .build(),
      'ERR_SCOPE_ALREADY_REGISTERED',
    )
    this.name = 'ErrScopeAlreadyRegistered'
  }
}

/**
 * ErrRepeatedInjectableConfiguration is an error that is thrown when a key is configured with multiple injectables.
 */
export class ErrRepeatedInjectableConfiguration extends CaffeineIoCError {
  constructor(message: string) {
    super(message, 'ERR_REPEATED_INJECTABLE')
    this.name = 'ErrRepeatedInjectableConfiguration'
  }
}

/**
 * ErrDuplicateBinding is thrown when a second binding is registered under a key that already has one, whatever made
 * either of them: a decorator, `bind()` or a module.
 */
export class ErrDuplicateBinding extends CaffeineIoCError {
  constructor(key: InjectionToken) {
    super(
      errMessage(`Cannot register "${keyStr(key)}": a binding is already registered under this key`)
        .solutions(
          `Use rebind() to replace the binding of "${keyStr(key)}" deliberately`,
          `Remove the bind() of a class that is already decorated, or set the "decorators" option to false`,
          `Give one of the bindings a profile or a condition, so that only one of them is registered`,
        )
        .reference('@caffeinejs/di', ErrDuplicateBinding)
        .build(),
      'ERR_DUPLICATE_BINDING',
    )
    this.name = 'ErrDuplicateBinding'
  }
}

/**
 * ErrInvalidBinding is an error that is thrown when a binding configuration is invalid.
 */
export class ErrInvalidBinding extends CaffeineIoCError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'ERR_INVALID_BINDING', options)
    this.name = 'ErrInvalidBinding'
  }
}

/**
 * ErrInvalidDecorator is an error that is thrown when a binding decorator is invalid.
 */
export class ErrInvalidDecorator extends CaffeineIoCError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'ERR_INVALID_DECORATOR', options)
    this.name = 'ErrInvalidDecorator'
  }
}

/**
 * ErrInvalidAspect is an error that is thrown when an aspect is misconfigured at compile time.
 */
export class ErrInvalidAspect extends CaffeineIoCError {
  constructor(message: string) {
    super(message, 'ERR_INVALID_ASPECT')
    this.name = 'ErrInvalidAspect'
  }
}

/**
 * ErrInjectableBase is thrown when a class decorated with `@Injectable` is used as an extension base by another `@Injectable` class.
 */
export class ErrInjectableBase extends CaffeineIoCError {
  static readonly code = 'ERR_INJECTABLE_BASE'
  override readonly code = ErrInjectableBase.code

  constructor(child: string, base: string) {
    super(
      errMessage(
        `Cannot register "${child}" extending "${base}": "${base}" is marked as @Injectable and cannot be used as an extension base. ` +
          `Remove @Injectable from "${base}" or make it abstract.`,
      )
        .reference('@caffeinejs/di', ErrInjectableBase)
        .build(),
      ErrInjectableBase.code,
    )
    this.name = 'ErrInjectableBase'
  }
}

/**
 * ErrOrphanedBindingConfig is an error that is thrown when a binding configuration is found for a key that is not decorated with an {@link Injectable} decorator.
 */
export class ErrOrphanedBindingConfig extends CaffeineIoCError {
  constructor(key: InjectionToken) {
    super(
      errMessage(
        `Found binding configuration for "${keyStr(key)}" but the type is not decorated with one of: @Injectable, @Extends`,
      )
        .reference('@caffeinejs/di', ErrOrphanedBindingConfig)
        .build(),
      'ERR_ORPHANED_BINDING_CONFIG',
    )
    this.name = 'ErrOrphanedBindingConfig'
  }
}

/**
 * ErrMultiplePrimary is an error that is thrown when a key has multiple primary bindings.
 */
export class ErrMultiplePrimary extends CaffeineIoCError {
  constructor(key: InjectionToken | Identifier) {
    super(
      errMessage(
        `Found multiple primary bindings for key "${keyStr(key)}": only one primary is allowed unless conditions reduce the candidates to exactly one`,
      )
        .solutions(
          `Use @Conditional to ensure only one primary injectable is active at a time`,
          `Leave only one injectable decorated with @Primary()`,
        )
        .reference('@caffeinejs/di', ErrMultiplePrimary)
        .build(),
      'ERR_MULTIPLE_PRIMARY_SAME_COMPONENT',
    )
    this.name = 'ErrMultiplePrimary'
  }
}

/**
 * ErrIllegalScopeState is an error that is thrown when a scope state is illegal/invalid.
 */
export class ErrIllegalScopeState extends CaffeineIoCError {
  constructor(message: string) {
    super(message, 'ERR_ILLEGAL_SCOPE_STATE')
    this.name = 'ErrIllegalScopeState'
  }
}

/**
 * ErrOutOfScope is an error that is thrown when a scope is out of scope.
 * Normally this error is thrown when a {@link RequestScope} is used outside of a run() call.
 */
export class ErrOutOfScope extends CaffeineIoCError {
  constructor(message: string) {
    super(message, 'ERR_OUT_OF_SCOPE')
    this.name = 'ErrOutOfScope'
  }
}

/**
 * ErrScopeMismatchInConfiguration is an error that is thrown when a {@link Provides} injectable is declared
 * with a different scope than the {@link Configuration} class.
 */
export class ErrScopeMismatchInConfiguration extends CaffeineIoCError {
  constructor(className: string, methodName: string, configScopeID: Identifier, methodScopeID: Identifier) {
    super(
      errMessage(
        `Cannot configure provider "${methodName}" in "${className}": the @Configuration class declares scope "${String(configScopeID)}" but the method declares scope "${String(methodScopeID)}"`,
      )
        .solutions(
          `Remove the scope configuration from the "${methodName}" method and let the @Configuration class scope apply to all provided components`,
          `Remove the scope from @Configuration and decorate each @Provides method individually with @Lifetime()`,
        )
        .reference('@caffeinejs/di', ErrScopeMismatchInConfiguration)
        .build(),
      'ERR_SCOPE_MISMATCH_IN_CONFIGURATION',
    )
    this.name = 'ErrScopeMismatchInConfiguration'
  }
}

/**
 * ErrUnknownResolver is an error that is thrown when a resolver for a component dependency is not registered.
 */
export class ErrUnknownResolver extends CaffeineIoCError {
  constructor(name: symbol) {
    super(
      errMessage(
        `Cannot resolve injection: resolver "${name.description ?? String(name)}" is not registered: use bindResolver() to register it`,
      )
        .reference('@caffeinejs/di', ErrUnknownResolver)
        .build(),
      'ERR_UNKNOWN_RESOLVER',
    )
    this.name = 'ErrUnknownResolver'
  }
}

/**
 * ErrResolverAlreadyRegistered is an error that is thrown when a resolver is already registered.
 */
export class ErrResolverAlreadyRegistered extends CaffeineIoCError {
  constructor(name: symbol) {
    super(
      errMessage(`Resolver "${name.description ?? String(name)}" is already registered`)
        .reference('@caffeinejs/di', ErrResolverAlreadyRegistered)
        .build(),
      'ERR_RESOLVER_ALREADY_REGISTERED',
    )
    this.name = 'ErrResolverAlreadyRegistered'
  }
}

/**
 * ErrUnknownInjectionStage is thrown when a descriptor names an injection stage that is not registered.
 */
export class ErrUnknownInjectionStage extends CaffeineIoCError {
  constructor(name: symbol) {
    super(
      errMessage(
        `Cannot resolve injection: stage "${name.description ?? String(name)}" is not registered: use registerStage() to register it`,
      )
        .reference('@caffeinejs/di', ErrUnknownInjectionStage)
        .build(),
      'ERR_UNKNOWN_INJECTION_STAGE',
    )
    this.name = 'ErrUnknownInjectionStage'
  }
}

/**
 * ErrInjectionStageAlreadyRegistered is thrown when an injection stage name is registered twice.
 */
export class ErrInjectionStageAlreadyRegistered extends CaffeineIoCError {
  constructor(name: symbol) {
    super(
      errMessage(`Injection stage "${name.description ?? String(name)}" is already registered`)
        .reference('@caffeinejs/di', ErrInjectionStageAlreadyRegistered)
        .build(),
      'ERR_INJECTION_STAGE_ALREADY_REGISTERED',
    )
    this.name = 'ErrInjectionStageAlreadyRegistered'
  }
}

/**
 * ErrConflictingInjectionStages is thrown when an injection names two stages that both produce the value.
 *
 * Only one stage in a chain may be terminal, because a terminal decides what the injection resolves to. Two of
 * them means the injection asks for two different results, e.g. `allOf(mapped(key))` asks for an array and a map.
 */
export class ErrConflictingInjectionStages extends CaffeineIoCError {
  constructor(first: symbol, second: symbol) {
    super(
      errMessage(
        `Cannot compose injection stages "${first.description ?? String(first)}" and "${second.description ?? String(second)}": both decide what the injection resolves to`,
      )
        .solutions(
          `Keep only one of them`,
          `Stages that transform or wrap, such as ordered and provide, compose with any of them`,
        )
        .reference('@caffeinejs/di', ErrConflictingInjectionStages)
        .build(),
      'ERR_CONFLICTING_INJECTION_STAGES',
    )
    this.name = 'ErrConflictingInjectionStages'
  }
}

/**
 * ErrMissingInjectionKey is an error that is thrown when a component dependency is missing a key.
 */
export class ErrMissingInjectionKey extends CaffeineIoCError {
  constructor(message: string) {
    super(message, 'ERR_MISSING_INJECTION_KEY')
    this.name = 'ErrMissingInjectionKey'
  }
}

/**
 * ErrNoValuesProvider is thrown when the values are read but `bindConfig()` was never called: by the container's
 * `values` getter, and when a `$i.config` injection that is neither optional nor has a default is compiled, which
 * `init()` does for every component. Likewise for `bindScopedConfig()`: by the `scopedConfig` getter, and for a
 * `$i.liveConfig` injection.
 */
export class ErrNoValuesProvider extends CaffeineIoCError {
  constructor(context?: string, binder: 'bindConfig' | 'bindScopedConfig' = 'bindConfig') {
    super(
      errMessage(
        `Cannot read values: no values are bound — call ${binder}() before init()` +
          (context === undefined ? '' : `\n${context}`),
      )
        .reference('@caffeinejs/di', ErrNoValuesProvider)
        .build(),
      'ERR_NO_VALUES_PROVIDER',
    )
    this.name = 'ErrNoValuesProvider'
  }
}

/**
 * ErrInvalidContainerState is an error that is thrown when an operation is not permitted
 * given the container's current initialization state.
 */
export class ErrInvalidContainerState extends CaffeineIoCError {
  constructor(message: string) {
    super(message, 'ERR_INVALID_CONTAINER_STATE')
    this.name = 'ErrInvalidContainerState'
  }
}

/**
 * ErrUnresolvableDependencies is an error that is thrown when a component dependency is unresolvable.
 */
export class ErrUnresolvableDependencies extends CaffeineIoCError {
  constructor(readonly issues: string[]) {
    super(
      errMessage(
        `Found ${issues.length} unresolvable ${issues.length === 1 ? 'dependency' : 'dependencies'}:\n${issues.join('\n')}`,
      )
        .reference('@caffeinejs/di', ErrUnresolvableDependencies)
        .build(),
      'ERR_UNRESOLVABLE_DEPENDENCIES',
    )
    this.name = 'ErrUnresolvableDependencies'
  }
}

/**
 * ErrConfigurationBindingNotFound is an error that is thrown when a configuration binding is not found.
 * Normally this error is thrown when using {@link Provides} decorators without decorating the holding class with {@link Configuration}.
 */
export class ErrConfigurationBindingNotFound extends CaffeineIoCError {
  constructor(target: Ctor) {
    super(
      errMessage(`Configuration binding not found for "${target.name}"`)
        .reference('@caffeinejs/di', ErrConfigurationBindingNotFound)
        .build(),
      'ERR_CONFIGURATION_BINDING_NOT_FOUND',
    )
    this.name = 'ErrConfigurationBindingNotFound'
  }
}

/**
 * ErrCircularDependency is an error that is thrown when a circular dependency is detected.
 */
export class ErrCircularDependency extends CaffeineIoCError {
  constructor(cycle: string) {
    super(
      errMessage(`Cannot initialize: circular dependency detected: ${cycle}`)
        .reference('@caffeinejs/di', ErrCircularDependency)
        .build(),
      'ERR_CIRCULAR_DEPENDENCY',
    )
    this.name = 'ErrCircularDependency'
  }
}

/**
 * ErrCircularCondition is thrown when the container compiles and bindings wait for each other to be decided: each has a
 * `present()` or `missing()` condition on a key another one answers to, as two defaults of one key nothing else binds
 * do. Which one should register is not decidable, so none is picked.
 */
export class ErrCircularCondition extends CaffeineIoCError {
  constructor(waits: string[]) {
    super(
      errMessage(`Cannot decide the conditions of bindings that wait for each other: ${waits.join('; ')}`)
        .solutions(
          `Bind the key yourself: a condition never waits on a key a registered binding answers to`,
          `Drop one of the present() or missing() conditions in the cycle`,
        )
        .reference('@caffeinejs/di', ErrCircularCondition)
        .build(),
      'ERR_CIRCULAR_CONDITION',
    )
    this.name = 'ErrCircularCondition'
  }
}

/**
 * ErrScopeMismatch is an error that is thrown when a component dependency graph is mixing different scopes.
 */
export class ErrScopeMismatch extends CaffeineIoCError {
  constructor(readonly violations: string[]) {
    super(
      errMessage(
        `Scope check detected ${violations.length} violation(s)\n\n` + violations.map(v => `  - ${v}`).join('\n'),
      )
        .solutions(
          'Use $i.provide(key) injection function and declare the parameter as Provider<T> to inject different-scoped dependencies',
          'Or align the scopes: make the dependency use the same scope as the consumer',
          "Or disable scope checks with { checks: { scopes: 'off' } } in the container options",
        )
        .reference('@caffeinejs/di', ErrScopeMismatch)
        .build(),
      'ERR_SCOPE_MISMATCH',
    )
    this.name = 'ErrScopeMismatch'
  }
}

/**
 * ErrNoRequestStorageSet is an error that is thrown when attempting to use the request scope feature
 * without setting its request scope storage.
 */
export class ErrNoRequestStorageSet extends CaffeineIoCError {
  constructor() {
    super(
      errMessage(
        'No request scope storage has been set.\n' +
          'Request scope is platform specific and must be manually set.\n' +
          'See the documentation for more information.',
      )
        .reference('@caffeinejs/di', ErrNoRequestStorageSet)
        .build(),
      'ERR_NO_REQUEST_SCOPE_STORAGE_SET',
    )
    this.name = 'ErrNoRequestScopeStorageSet'
  }
}

/**
 * ErrCannotLoadTypeScriptModule is an error that is thrown when attempting to load a TypeScript module
 * in a runtime that does not support TypeScript natively.
 */
export class ErrCannotLoadTypeScriptModule extends CaffeineIoCError {
  constructor(file: string) {
    super(
      errMessage(
        `Cannot load module at "${file}": TypeScript is not supported in this runtime — compile to JavaScript or run with a TypeScript-capable runtime`,
      )
        .reference('@caffeinejs/di', ErrCannotLoadTypeScriptModule)
        .build(),
      'ERR_CANNOT_LOAD_TYPESCRIPT_MODULE',
    )
    this.name = 'ErrCannotLoadTypeScriptModule'
  }
}
