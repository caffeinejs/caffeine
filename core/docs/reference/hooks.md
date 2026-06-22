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
  - [onSetup](#onsetup)
  - [onBindingRegistered](#onbindingregistered)
  - [onBindingNotRegistered](#onbindingnotregistered)
  - [onSetupComplete](#onsetupcomplete)
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
container.hooks.on('onSetupComplete', () => {
  console.log('Container ready')
})
```

### off

```ts
off<E extends keyof Hooks>(event: E, listener: (args: Hooks[E]) => void): this
```

Removes a previously registered listener.

```ts
const handler = ({ key }: { key: Key }) => console.log(key)

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

### onSetup

Fired for each binding as the container processes it during startup. Fires
before the binding is accepted or rejected.

```ts
container.hooks.on('onSetup', ({ key, binding }) => {
  // key: Key
  // binding: BindingDecoratorConfig
})
```

### onBindingRegistered

Fired when a binding passes all conditions (profiles, conditionals) and is
accepted into the container.

```ts
container.hooks.on('onBindingRegistered', ({ key, binding }) => {
  // key: Key
  // binding: BindingDecoratorConfig
})
```

### onBindingNotRegistered

Fired when a binding is evaluated but skipped — for example, because its
`@Profile` is not active or its `@ConditionalOn` predicate returned `false`.

```ts
container.hooks.on('onBindingNotRegistered', ({ key, binding }) => {
  // key: Key
  // binding: BindingDecoratorConfig
})
```

### onSetupComplete

Fired once after all bindings have been processed and the container has
finished its setup phase.

```ts
container.hooks.on('onSetupComplete', () => {
  // no args
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
  // key: Key
  // binding: Binding
  // instance: unknown — the created instance
  // async: boolean — true if created by an async factory
})
```

### onBindingInitializationFailed

Fired when instance creation throws.

```ts
container.hooks.on('onBindingInitializationFailed', ({ key, binding, error, async }) => {
  // key: Key
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
