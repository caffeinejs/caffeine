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
  - [onDecoratedBindingWired](#ondecoratedbindingwired)
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
container.hooks.on('onDisposed', () => {
  console.log('Container disposed')
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

### onDecoratedBindingWired

Fired by `autoWire()` for each decorated class and `@Provides` method, before
the container registers the binding or holds it back for its profiles or
conditions. It is the only event `autoWire()` emits.

`autoWire()` runs in the constructor unless `decorators` is `false`. To observe
it, attach the listener to a container created without decorators, then call
`autoWire()`:

```ts
const di = new CaffeineIoC({ decorators: false })

di.hooks.on('onDecoratedBindingWired', ({ key, binding }) => {
  // key: InjectionToken
  // binding: Binding
})

di.autoWire()
```

### onBindingRegistered

Fired during `compile()` / `init()` when a binding held back until then is
registered: one with conditions, one none of whose profiles was active when it
was made, or a `@Provides` waiting on its `@Configuration` class. A binding
registered where it was made — by `bind()`, a module or `autoWire()` — emits
nothing.

```ts
container.hooks.on('onBindingRegistered', ({ key, binding }) => {
  // key: InjectionToken
  // binding: Binding
})
```

### onBindingNotRegistered

Fired during `compile()` / `init()` when a binding held back until then is left
out: none of its profiles is active, a `@ConditionalOn` predicate returned
`false`, or it is a `@Provides` whose `@Configuration` class was left out.

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

Fired after an instance is created and fully initialized (including
`@PostConstruct` hooks).

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
