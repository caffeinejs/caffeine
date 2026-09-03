# Errors

CaffeineIoC errors extend `CaffeineIoCError`, which in turn extends `Error`. All errors
carry a `code` string that identifies the error type programmatically.

```ts
import { ErrNoResolutionForKey } from '@caffeinejs/di'

try {
  di.get(SomeService)
} catch (err) {
  if (err instanceof ErrNoResolutionForKey) {
    console.error(`Missing binding: ${err.message}`)
  }
}
```

The `.code` string matches the class name in `SCREAMING_SNAKE_CASE`:
`ErrFoo` → `code = 'ERR_FOO'`.

---

## Error reference

### ErrNoResolutionForKey

**Code:** `ERR_NO_RESOLUTION_FOR_KEY`

Thrown by `di.get()` and `di.getMany()` when no binding is registered for the
requested key.

**Fix:** Register the key with `di.bind()` or `@Injectable()`, or use
`di.getOptional()` if the dependency is not required.

---

### ErrNoUniqueInjectionForKey

**Code:** `ERR_NO_UNIQUE_INJECTION_FOR_KEY`

Thrown by `di.get()` when multiple bindings exist for a key and none is marked
`@Primary`.

**Fix:** Mark one binding as `@Primary()`, or use `di.getMany()` to retrieve
all of them.

---

### ErrScopeNotRegistered

**Code:** `ERR_SCOPE_NOT_REGISTERED`

Thrown during `init()` when a binding uses a scope identifier that is not
registered.

**Fix:** Call `bindScope(id, factory)` before creating the container. For the
built-in `REQUEST` scope, ensure you are importing from `@caffeinejs/di`
in a Node.js environment (which auto-registers it).

---

### ErrScopeAlreadyRegistered

**Code:** `ERR_SCOPE_ALREADY_REGISTERED`

Thrown by `bindScope()` when the scope identifier is already bound.

**Fix:** Check with `hasScope(id)` before calling `bindScope()`, or call
`unbindScope(id)` first.

---

### ErrRepeatedInjectableConfiguration

**Code:** `ERR_REPEATED_INJECTABLE_CONFIGURATION`

Thrown when `@Injectable` is applied to the same class more than once.

**Fix:** Remove duplicate `@Injectable` annotations.

---

### ErrInvalidBinding

**Code:** `ERR_INVALID_BINDING`

Thrown when the `BindingSpec` fluent API is used incorrectly — an injection
count that does not match the constructor, a scope that was never registered, or
a component listed among its own dependencies.

**Fix:** Read the error message for the specific constraint that was violated.

---

### ErrInvalidContainerState

**Code:** `ERR_INVALID_CONTAINER_STATE`

Thrown when a lifecycle operation is called in the wrong order — for example,
calling `di.get()` before `await di.init()`, or `init()` after `dispose()`.

**Fix:** Ensure `await di.init()` is called before any resolution, and do not
call `init()` more than once on the same container.

---

### ErrOrphanedBindingConfig

**Code:** `ERR_ORPHANED_BINDING_CONFIG`

Thrown when a binding decorator (e.g. `@Lifetime`, `@Named`) is used on a
class that is not annotated with `@Injectable` or `@Configuration`.

**Fix:** Add `@Injectable()` or `@Configuration()` to the class.

---

### ErrMultiplePrimary

**Code:** `ERR_MULTIPLE_PRIMARY`

Thrown during `init()` when more than one binding for the same key is marked
`@Primary`.

**Fix:** Only one binding per key may be primary. Remove the extra `@Primary`
annotation.

---

### ErrMissingInjectionKey

**Code:** `ERR_MISSING_INJECTION_KEY`

Thrown by injection helpers (`allOf`, `provide`, etc.) when the key passed to
them is `null` or `undefined`. Often caused by a circular module import where
the class reference is `undefined` at declaration time.

**Fix:** Use `defer(() => ClassName)` or `DeferredCtor` to break the circular
import.

---

### ErrInvalidDecorator

**Code:** `ERR_INVALID_DECORATOR`

Thrown when a decorator is applied in an unsupported location — for example,
`@Provides` outside a `@Configuration` class.

**Fix:** Check the [Decorators reference](./decorators.md) for valid usage.

---

### ErrResolverAlreadyRegistered

**Code:** `ERR_RESOLVER_ALREADY_REGISTERED`

Thrown by `bindResolver()` when the resolver symbol is already bound.

**Fix:** Check with `hasResolver(symbol)` before calling `bindResolver()`.

---

### ErrUnknownResolver

**Code:** `ERR_UNKNOWN_RESOLVER`

Thrown during injection compilation when an `InjectionDescriptor` references a
resolver symbol that is not registered.

**Fix:** Call `bindResolver(symbol, factory)` before `di.init()`.

---

### ErrCannotLoadTypeScriptModule

**Code:** `ERR_CANNOT_LOAD_TYPESCRIPT_MODULE`

Thrown by `scan()` when it attempts to import a `.ts` source file. Scan
operates on compiled output only.

**Fix:** Run the TypeScript compiler before scanning, and point `dir` at the
compiled output directory.

---

### ErrScopeMismatchInConfiguration

**Code:** `ERR_SCOPE_MISMATCH_IN_CONFIGURATION`

Thrown when a `@Configuration` class and one of its `@Provides` methods have
conflicting scope declarations.

**Fix:** Ensure the scopes are consistent, or separate the conflicting factory
methods into different configuration classes.
