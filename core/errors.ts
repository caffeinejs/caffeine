import { keyStr, Key, Identifier } from './key.js'
import { Named } from './decorators/named.js'
import { Primary } from './decorators/primary.js'
import { ConditionalOn } from './decorators/conditional_on.js'
import { Lifetime } from './decorators/lifetime.js'
import { Injectable } from './decorators/injectable.js'
import { Configuration } from './decorators/configuration.js'
import { Provides } from './decorators/provides.js'
import { Ctor } from './types.js'
import { Extends } from './decorators/extends.js'
import { solutions } from './internal/util/errutil/index.js'
import { allOf } from './injection.js'

/**
 * DiCafError is the base error class for all errors thrown by the DiCaf library.
 */
export class DiCafError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

/**
 * ErrNoUniqueInjectionForKey is an error that is thrown when requesting a single instance of a key
 * that has more than one injectable bound to it, without a disambiguation strategy.
 */
export class ErrNoUniqueInjectionForKey extends DiCafError {
  constructor(key: Key, message?: string) {
    super(
      (message ?? `Found more than one component bound to the key "${keyStr(key)}" when a single one was expected`)
      + solutions(
        `Use ${allOf.name}(key) if you want to inject multiple instances bound to the key "${keyStr(key)}"`,
        `Use @${Named.name} providing a name to differentiate injectables and inject the dependency using it`,
        `Use @${Primary.name} to specify an unique injectable`,
        `Use @${ConditionalOn.name} to conditionally register injectables, leaving only one for the given key`,
      ),
      'ERR_NO_UNIQUE_INJECTION',
    )
    this.name = 'ErrNoUniqueInjectionForKey'
  }
}

/**
 * ErrNoResolutionForKey is an error that is thrown when no resolution is found for a key.
 */
export class ErrNoResolutionForKey extends DiCafError {
  constructor(message: string) {
    super(message, 'ERR_NO_RESOLUTION_FOR_KEY')
    this.name = 'ErrNoResolutionForKey'
  }
}

/**
 * ErrScopeNotRegistered is an error that is thrown when binding to a scope that is not registered.
 */
export class ErrScopeNotRegistered extends DiCafError {
  constructor(scopeId: Identifier) {
    super(`Scope "${scopeId.toString()}" is not registered: use bindScope() to register it`, 'ERR_SCOPE_NOT_REGISTERED')
    this.name = 'ErrScopeNotRegistered'
  }
}

/**
 * ErrScopeAlreadyRegistered is an error that is thrown when binding to a scope that is already registered.
 */
export class ErrScopeAlreadyRegistered extends DiCafError {
  constructor(scopeId: Identifier) {
    super(`Scope "${scopeId.toString()}" is already registered`, 'ERR_SCOPE_ALREADY_REGISTERED')
    this.name = 'ErrScopeAlreadyRegistered'
  }
}

/**
 * ErrRepeatedInjectableConfiguration is an error that is thrown when a key is configured with multiple injectables.
 */
export class ErrRepeatedInjectableConfiguration extends DiCafError {
  constructor(message: string) {
    super(message, 'ERR_REPEATED_INJECTABLE')
    this.name = 'ErrRepeatedInjectableConfiguration'
  }
}

/**
 * ErrInvalidBinding is an error that is thrown when a binding configuration is invalid.
 */
export class ErrInvalidBinding extends DiCafError {
  constructor(message: string) {
    super(message, 'ERR_INVALID_BINDING')
    this.name = 'ErrInvalidBinding'
  }
}

/**
 * ErrInvalidDecorator is an error that is thrown when a binding decorator is invalid.
 */
export class ErrInvalidDecorator extends DiCafError {
  constructor(message: string) {
    super(message, 'ERR_INVALID_DECORATOR')
    this.name = 'ErrInvalidDecorator'
  }
}

/**
 * ErrOrphanedBindingConfig is an error that is thrown when a binding configuration is found for a key that is not decorated with an {@link Injectable} decorator.
 */
export class ErrOrphanedBindingConfig extends DiCafError {
  constructor(key: Key) {
    super(
      `Found binding configuration for "${keyStr(key)}" but the type is not decorated with one of: @${Injectable.name}, @${Extends.name}`,
      'ERR_ORPHANED_BINDING_CONFIG',
    )
    this.name = 'ErrOrphanedBindingConfig'
  }
}

/**
 * ErrMultiplePrimary is an error that is thrown when a key has multiple primary bindings.
 */
export class ErrMultiplePrimary extends DiCafError {
  constructor(key: Key) {
    super(
      `Found multiple primary bindings for key "${keyStr(key)}": only one primary is allowed unless conditionals reduce the candidates to exactly one`
      + solutions(
        `Use @${ConditionalOn.name}(condition) to ensure only one primary injectable is active at a time`,
        `Leave only one injectable decorated with @${Primary.name}()`,
      ),
      'ERR_MULTIPLE_PRIMARY_SAME_COMPONENT',
    )
    this.name = 'ErrMultiplePrimary'
  }
}

/**
 * ErrIllegalScopeState is an error that is thrown when a scope state is illegal/invalid.
 */
export class ErrIllegalScopeState extends DiCafError {
  constructor(message: string) {
    super(message, 'ERR_ILLEGAL_SCOPE_STATE')
    this.name = 'ErrIllegalScopeState'
  }
}

/**
 * ErrOutOfScope is an error that is thrown when a scope is out of scope.
 * Normally this error is thrown when a {@link RequestScope} is used outside of a run() call.
 */
export class ErrOutOfScope extends DiCafError {
  constructor(message: string) {
    super(message, 'ERR_OUT_OF_SCOPE')
    this.name = 'ErrOutOfScope'
  }
}

/**
 * ErrScopeMismatchInConfiguration is an error that is thrown when a {@link Provides} injectable is declared
 * with a different scope than the {@link Configuration} class.
 */
export class ErrScopeMismatchInConfiguration extends DiCafError {
  constructor(className: string, methodName: string, configScopeId: Identifier, methodScopeId: Identifier) {
    super(
      `Cannot configure provider "${methodName}" in "${className}": the @${Configuration.name} class declares scope "${String(configScopeId)}" but the method declares scope "${String(methodScopeId)}"`
      + solutions(
        `Remove the scope configuration from the "${methodName}" method and let the @${Configuration.name} class scope apply to all provided components`,
        `Remove the scope from @${Configuration.name} and decorate each @${Provides.name} method individually with @${Lifetime.name}()`,
      ),
      'ERR_SCOPE_MISMATCH_IN_CONFIGURATION',
    )
    this.name = 'ErrScopeMismatchInConfiguration'
  }
}

/**
 * ErrUnknownResolver is an error that is thrown when a resolver for a component dependency is not registered.
 */
export class ErrUnknownResolver extends DiCafError {
  constructor(name: symbol) {
    super(
      `Cannot resolve injection: resolver "${name.description ?? String(name)}" is not registered: use bindResolver() to register it`,
      'ERR_UNKNOWN_RESOLVER',
    )
    this.name = 'ErrUnknownResolver'
  }
}

/**
 * ErrResolverAlreadyRegistered is an error that is thrown when a resolver is already registered.
 */
export class ErrResolverAlreadyRegistered extends DiCafError {
  constructor(name: symbol) {
    super(`Resolver "${name.description ?? String(name)}" is already registered`, 'ERR_RESOLVER_ALREADY_REGISTERED')
    this.name = 'ErrResolverAlreadyRegistered'
  }
}

/**
 * ErrMissingInjectionKey is an error that is thrown when a component dependency is missing a key.
 */
export class ErrMissingInjectionKey extends DiCafError {
  constructor(message: string) {
    super(message, 'ERR_MISSING_INJECTION_KEY')
    this.name = 'ErrMissingInjectionKey'
  }
}

/**
 * ErrInvalidContainerState is an error that is thrown when an operation is not permitted
 * given the container's current initialization state.
 */
export class ErrInvalidContainerState extends DiCafError {
  constructor(message: string) {
    super(message, 'ERR_INVALID_CONTAINER_STATE')
    this.name = 'ErrInvalidContainerState'
  }
}

/**
 * ErrUnresolvableDependencies is an error that is thrown when a component dependency is unresolvable.
 */
export class ErrUnresolvableDependencies extends DiCafError {
  constructor(readonly issues: string[]) {
    super(
      `Found ${issues.length} unresolvable ${issues.length === 1 ? 'dependency' : 'dependencies'}:\n${issues.join('\n')}`,
      'ERR_UNRESOLVABLE_DEPENDENCIES',
    )
    this.name = 'ErrUnresolvableDependencies'
    this.issues = issues
  }
}

/**
 * ErrConfigurationBindingNotFound is an error that is thrown when a configuration binding is not found.
 * Normally this error is thrown when using {@link Provides} decorators without decorating the holding class with {@link Configuration}.
 */
export class ErrConfigurationBindingNotFound extends DiCafError {
  constructor(target: Ctor) {
    super(`Configuration binding not found for "${target.name}"`, 'ERR_CONFIGURATION_BINDING_NOT_FOUND')
    this.name = 'ErrConfigurationBindingNotFound'
  }
}

/**
 * ErrCircularDependency is an error that is thrown when a circular dependency is detected.
 */
export class ErrCircularDependency extends DiCafError {
  constructor(cycle: string) {
    super(`Cannot initialize: circular dependency detected: ${cycle}`, 'ERR_CIRCULAR_DEPENDENCY')
    this.name = 'ErrCircularDependency'
  }
}

/**
 * ErrScopeMismatch is an error that is thrown when a component dependency graph is mixing different scopes.
 */
export class ErrScopeMismatch extends DiCafError {
  constructor(readonly violations: string[]) {
    super(
      `Scope check detected ${violations.length} violation(s)\n\n`
      + violations.map(v => `  - ${v}`)
        .join('\n')
        + solutions(
          'Use provide(key) injection function and declare the parameter as Provider<T> to inject different-scoped dependencies',
          'Or align the scopes: make the dependency use the same scope as the consumer',
          'Or disable scope checks with { checks: { scopes: \'off\' } } in the container options',
        ),
      'ERR_SCOPE_MISMATCH',
    )
    this.name = 'ErrScopeMismatch'
    this.violations = violations
  }
}

/**
 * ErrNoRequestStorageSet is an error that is thrown when attempting to use the request scope feature
 * without setting its request scope storage.
 */
export class ErrNoRequestStorageSet extends DiCafError {
  constructor() {
    super(
      'No request scope storage has been set.\n'
      + 'Request scope is platform specific and must be manually set.\n'
      + 'See the documentation for more information.',
      'ERR_NO_REQUEST_SCOPE_STORAGE_SET',
    )
    this.name = 'ErrNoRequestScopeStorageSet'
  }
}

/**
 * ErrCannotLoadTypeScriptModule is an error that is thrown when attempting to load a TypeScript module
 * in a runtime that does not support TypeScript natively.
 */
export class ErrCannotLoadTypeScriptModule extends DiCafError {
  constructor(file: string) {
    super(
      `Cannot load module at "${file}": TypeScript is not supported in this runtime — compile to JavaScript or run with a TypeScript-capable runtime`,
      'ERR_CANNOT_LOAD_TYPESCRIPT_MODULE',
    )
    this.name = 'ErrCannotLoadTypeScriptModule'
  }
}
