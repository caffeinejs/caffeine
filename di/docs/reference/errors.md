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

### ErrDuplicateBinding

**Code:** `ERR_DUPLICATE_BINDING`

Thrown during `compile()` / `init()` when a key ends up with a second binding,
whatever made either of them: a decorated class also bound with `bind()`, two
`@Provides` methods for one key, a module binding a key already bound, or a
conditional binding whose predicate passes while another binding holds its key.
Profiles and conditions are decided first, so bindings of one key that they
leave to a single survivor do not throw.

**Fix:** Use `rebind()` to replace a binding deliberately. Remove the `bind()` of
a class that is already decorated, or turn the `decorators` option off. Give one
of the bindings a profile or a condition so that only one of them is registered.

---

### ErrRepeatedInjectableConfiguration

**Code:** `ERR_REPEATED_INJECTABLE`

Thrown when decorators give one binding the same name twice.

**Fix:** Remove the repeated name.

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

Thrown when an operation is called in the wrong phase — for example, calling
`di.get()` before `await di.init()`, `bind()` after the container has registered
its bindings (`compile()`, `init()` or `assertResolvable()` has run), or `addProfiles()`, `addModules()`, `restore()` or `overrides()` once it has
started compiling.

**Fix:** Declare everything before `init()`, and resolve only after it.
`init()` itself can be called more than once: later calls do nothing.

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

### ErrNoValuesProvider

**Code:** `ERR_NO_VALUES_PROVIDER`

Thrown when the values are read but `di.bindConfig()` was never called: by the
container's `values` getter, and when a `$i.config()` injection that is neither optional nor
has a default is compiled — by `init()` for a component, or by `resolver()` and `builder()`.
The second names the injection that needed the values. The same holds for `di.bindScopedConfig()`:
the `scopedConfig` getter, and a `$i.liveConfig()` injection, throw it when no provider was bound,
and the message names `bindScopedConfig()`.

**Fix:** Call `di.bindConfig(values)` (or `di.bindScopedConfig(provider)`) before `init()`, give the
injection a default (`$i.config('database.port', 5432)`), or check `di.hasValues` before reading
`di.values`.

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
