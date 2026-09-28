# Hooks

The `HookListener` is available on every container via `container.hooks`. It
emits events at key points in the container's setup and runtime lifecycle.

```ts
container.hooks.on('onBindingInitialized', ({ key, instance }) => {
  console.log(`Created ${String(key)}`)
})
```

- [HookListener](#hooklistener)
  - [on](#on)
  - [off](#off)
  - [emit](#emit)
- [Events](#events)
  - [onDecoratedBinding](#ondecoratedbinding)
  - [onBindingRegistered](#onbindingregistered)
  - [onBindingNotRegistered](#onbindingnotregistered)
  - [onModuleRegistered](#onmoduleregistered)
  - [onModuleRegistrationFailed](#onmoduleregistrationfailed)
  - [onBindingInitialized](#onbindinginitialized)
  - [onBindingInitializationFailed](#onbindinginitializationfailed)
  - [onDisposed](#ondisposed)

---

## HookListener

### on

```ts
on<E extends keyof Hooks>(event: E, listener: (args: Hooks[E]) => void): this
```

Registers a listener for an event. Returns the `HookListener` instance for
chaining. Throws if the same listener function is registered twice for the
same event.

```ts
container.hooks.on('onBindingRegistered', ({ key }) => {
  console.log(`Registered ${String(key)}`)
})
```

### off

```ts
off<E extends keyof Hooks>(event: E, listener: (args: Hooks[E]) => void): this
```

Removes a previously registered listener.

```ts
const handler = ({ key }: { key: InjectionToken }) => console.log(key)

container.hooks.on('onBindingRegistered', handler)
container.hooks.off('onBindingRegistered', handler)
```

### emit

```ts
emit<E extends keyof Hooks>(event: E, args?: Hooks[E]): boolean
```

Fires an event synchronously. Returns `true` if at least one listener was
called. Normally called by the container itself; exposed for custom scope
and module implementations.

---

## Events

Nothing is registered before the container compiles, so a listener attached
any time before `compile()` / `init()` sees every registration event.

### onDecoratedBinding

Fired once for each decorated binding (`@Injectable`, `@Configuration`,
`@Provides`, …) when the container compiles, just before it is registered and
before its profiles and conditions are decided. Not fired when the
`decorators` option is off.

```ts
container.hooks.on('onDecoratedBinding', ({ key, binding }) => {
  // key: InjectionToken
  // binding: Binding
})
```

### onBindingRegistered

Fired once for every binding the container holds after compiling, however it
was made: decorated, bound by hand, bound by a module or added by an override.
Fires after profiles, conditions and overrides are decided.

```ts
container.hooks.on('onBindingRegistered', ({ key, binding }) => {
  // key: InjectionToken
  // binding: Binding
})
```

### onBindingNotRegistered

Fired once for every binding the container left out when compiling: its
profile is not active, a condition returned `false`, or a `rebind()` or an
override replaced or removed it.

```ts
container.hooks.on('onBindingNotRegistered', ({ key, binding }) => {
  // key: InjectionToken
  // binding: Binding
})
```

### onModuleRegistered

Fired after a module function is applied successfully.

```ts
container.hooks.on('onModuleRegistered', ({ name, index }) => {
  // name: string — the module's debug name (set via mod())
  // index: number — position in the modules array
})
```

### onModuleRegistrationFailed

Fired when a module function throws.

```ts
container.hooks.on('onModuleRegistrationFailed', ({ name, index, error }) => {
  // name: string
  // index: number
  // error: Error
})
```

### onBindingInitialized

Fired during `init()` after an eager or async binding's instance is created and
fully initialized (including `@PostConstruct` hooks). A lazy binding resolved
later does not fire it.

```ts
container.hooks.on('onBindingInitialized', ({ key, binding, instance, async }) => {
  // key: InjectionToken
  // binding: Binding
  // instance: unknown — the created instance
  // async: boolean — true if created by an async factory
})
```

### onBindingInitializationFailed

Fired when instance creation throws.

```ts
container.hooks.on('onBindingInitializationFailed', ({ key, binding, error, async }) => {
  // key: InjectionToken
  // binding: Binding
  // error: unknown — the thrown error
  // async: boolean
})
```

### onDisposed

Fired after `container.dispose()` completes.

```ts
container.hooks.on('onDisposed', () => {
  // no args
})
```
