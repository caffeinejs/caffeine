# Thinking in scopes

A scope answers one question: **for a given resolution request, should I create
a new instance or return an existing one?**

Every binding has exactly one scope, chosen at registration time. Getting scopes
wrong produces bugs that are hard to reproduce — one service receives a stale
instance, or a resource is created thousands of times instead of once.

---

## The two properties of a scope

Every scope has two boolean properties that determine its behaviour.

**Durable** means the scope lives as long as the container. Singleton is durable. Request and transient scopes are not — their instances are short-lived.

**Lazy** means the container does not create instances during `init()`. It
waits until the binding is first resolved. Singleton is eager (lazy = false)
by default; request and transient scopes are lazy because they cannot be
created without a live context.

---

## Scope lifetimes, ranked

From longest to shortest:

```
SINGLETON  — one instance for the life of the container
REFRESH    — singleton that can be reset programmatically
REQUEST    — one instance per async operation
TRANSIENT  — new instance every time
```

---

## The scope compatibility rule

A longer-lived binding that directly depends on a shorter-lived one is almost
always a bug. The canonical case:

```ts
@Injectable([EmailSender])  // transient
@Lifetime(Scopes.SINGLETON)
class NotificationService { ... }
```

`NotificationService` is a singleton. It receives `EmailSender` during `init()`,
and holds it forever. But `EmailSender` was transient — it was supposed to be
created fresh on every use. The singleton accidentally froze one transient
instance for its entire lifetime. DiCaf throws during `init()` to prevent this.

The technical term for this bug is a **scope leak**.

### How to fix a scope leak

**Option 1 — Lift the dependency to the same scope.** If `EmailSender` is
stateless, make it a singleton too.

**Option 2 — Use a `Provider`.** Wrap the short-lived dependency so the
singleton calls `provider.get()` each time it needs a fresh instance:

```ts
import { provide } from '@caffeine-projects/dicaf'

@Injectable([provide(EmailSender)])
@Lifetime(Scopes.SINGLETON)
class NotificationService {
  constructor(private readonly sender: Provider<EmailSender>) {}

  notify(msg: string): void {
    this.sender.get().send(msg) // fresh EmailSender each call
  }
}
```

**Option 3 — Disable validation.** If you know what you are doing:

```ts
new DiCaf({ checks: { scopes: 'off' } })
```

---

## Request scope and async context

`Scopes.REQUEST` creates one instance per `AsyncLocalStorage` context. Two
concurrent requests each get their own instance of a request-scoped binding,
even though they resolve the same key.

```ts
app.use((req, res, next) => {
  container.requestScopeManager.run(() => next())
})
```

Everything running inside the `run()` callback — across awaits, across service
calls — resolves the same request-scoped instances. Outside that callback,
request-scoped resolution throws.

---

## Refresh scope as controlled invalidation

`Scopes.REFRESH` is a singleton with a reset mechanism. Use it for data that
is loaded once at startup but needs to be reloaded without restarting the
process — configuration pulled from a remote vault, feature flags, or
certificate rotation.

```ts
await container.refresher.refresh()
// next di.get(RemoteConfig) creates a fresh instance
```

`refresh()` clears all refresh-scoped instances atomically. Pre-destroy hooks
are not called on the old instances — if you need cleanup, do it in the
factory or the `PostConstruct` hook.

---

## Custom scopes

If none of the built-in scopes fits — for example, you need one instance per
WebSocket connection — you can implement the `Scope` interface and register it
with `bindScope()`. See [Scopes reference](../reference/scopes.md#custom-scopes)
for the full implementation guide.
