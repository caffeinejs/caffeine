# Mixing Scopes

By default, CaffeineIoC prevents scope violations at initialization time: a longer-lived
component cannot hold a direct reference to a shorter-lived one, because the
shorter-lived instance would be captured and reused for the lifetime of the
longer-lived owner — the classic **scope leak**.

The `provide()` injection function solves this by wrapping the dependency in a
`Provider<T>` that defers resolution to call time, bypassing the lifetime check.

---

## The problem: scope leak

```ts
// WRONG — singleton captures a transient instance once and holds it forever
@Injectable()
@Lifetime(Scopes.SINGLETON)
class ReportService {
  constructor(private readonly session: UserSession) {} // UserSession is TRANSIENT
}
```

With the `checks.scopes` option set to `'no-mix'` or `'compatible-scopes-only'`, the
container throws `ErrScopeMismatch` at `init()` when it detects this pattern.
Even without the check enabled, the bug exists silently: `session` is resolved once
and the same stale instance is reused for every request.

:::warning
CaffeineIoC does not perform scope bubbling. Frameworks like NestJS silently promote a
shorter-lived dependency to the lifetime of its consumer. CaffeineIoC refuses to do this —
the scope each binding declares is the scope it keeps. Use `provide()` to cross scope
boundaries explicitly.
:::

---

## The solution: `provide()` and `Provider<T>`

```ts
import { provide } from '@caffeinejs/di'
import type { Provider } from '@caffeinejs/di'
```

`provide(key)` wraps the dependency in a `Provider<T>`. The provider's `get()` method
resolves the dependency fresh on every call, so the owner never holds a stale reference.

```ts
interface Provider<T> {
  get(): T
}
```

Scope-checking is skipped for `provide()` injections because the owner only holds
the provider handle, not the dependency instance itself.

:::note
`Provider<T>` is performance-optimized for singleton and refresh scopes — the resolver
is pre-processed during container initialization, so `get()` calls are cheap. For
transient dependencies, each call to `get()` creates a new instance by design, which
adds a small overhead compared to a direct injection. This is expected behavior and rarely a concern in practice.
:::

---

## Basic example

```ts
import { Injectable, Lifetime } from '@caffeinejs/di'
import { provide } from '@caffeinejs/di'
import type { Provider } from '@caffeinejs/di'
import { Scopes } from '@caffeinejs/di'

@Injectable()
@Lifetime(Scopes.TRANSIENT)
class EmailSender {
  send(to: string, body: string) {
    /* ... */
  }
}

@Injectable([provide(EmailSender)])
@Lifetime(Scopes.SINGLETON)
class NotificationService {
  constructor(private readonly sender: Provider<EmailSender>) {}

  notify(to: string, body: string) {
    this.sender.get().send(to, body) // fresh EmailSender on each call
  }
}
```

---

## Best practices

### Singleton controller with a request-scoped dependency

A common real-world pattern: an HTTP controller is a singleton (created once per
application), but it needs access to the current request's context — which is
request-scoped and different on every call.

Injecting the request context directly would be a scope leak. Use `provide()` so
the controller fetches the live context on each request.

```ts
import { Injectable, Lifetime } from '@caffeinejs/di'
import { provide } from '@caffeinejs/di'
import type { Provider } from '@caffeinejs/di'
import { Scopes } from '@caffeinejs/di'

@Injectable()
@Lifetime(Scopes.REQUEST)
class RequestContext {
  readonly requestId = crypto.randomUUID()
  readonly startedAt = Date.now()
}

@Injectable([provide(RequestContext)])
@Lifetime(Scopes.SINGLETON)
class OrderController {
  constructor(private readonly ctx: Provider<RequestContext>) {}

  handle() {
    const context = this.ctx.get() // resolves the current request's instance
    console.log(`Handling request ${context.requestId}`)
    // ...
  }
}
```

`RequestContext` is created fresh per request inside a `RequestScopeManager.run()`
block. `OrderController` is created once and holds only the provider, so each call
to `this.ctx.get()` returns the context for the active request — never a stale one.

### When to use `provide()`

Use `provide()` when:

- A singleton or long-lived component needs a transient, request-scoped, or
  refresh-scoped dependency
- You want lazy resolution — the dependency is only created when `get()` is actually
  called, not at container initialization
- You want a new instance on each invocation (transient) rather than sharing one

Do not use `provide()` just to silence a scope-mismatch error without understanding
the lifecycle implications — the error is telling you something real about the design.

---

## Scope check mode

Enable scope validation at container level to catch violations early.  
By default, the container uses: `compatible-scopes-only`.

```ts
const di = new CaffeineIoC({ checks: { scopes: 'compatible-scopes-only' } })
```

Use `'compatible-scopes-only'` for a relaxed variant that allows a durable scope
to depend on another durable scope, while blocking durable → non-durable
(transient, request) direct injections. A refresh-scoped dependency is blocked
too, even though refresh is durable: `refresher.refresh()` replaces the instance
and runs its pre-destroy hook, so a consumer that captured it directly would keep
a destroyed object. Only another refresh binding may hold one; everything else
uses `provide()`.

With `'no-mix'`, the container throws `ErrScopeMismatch` during `init()` for any
direct injection across different scopes. `provide()` injections are exempt because
they defer resolution correctly.

:::warning
Keep scope checking enabled. Disabling it (`checks: { scopes: 'off' }`) lets scope
leaks through silently; omitting the option keeps the default on. `'compatible-scopes-only'` is the
recommended baseline for most applications — it catches the dangerous cases (durable
holding a non-durable reference) without rejecting benign same-lifetime dependencies.
Only tighten to `'no-mix'` if you want strict enforcement across every scope boundary.
:::
