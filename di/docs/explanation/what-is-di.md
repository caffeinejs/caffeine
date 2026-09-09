# What is dependency injection?

Dependency injection (DI) is a technique for constructing objects so that their
collaborators are supplied from the outside rather than created internally.

## The problem it solves

Consider a `UserService` that sends emails:

```ts
class UserService {
  private readonly mailer = new SmtpMailer('smtp.example.com', 587)

  register(email: string): void {
    this.mailer.send(email, 'Welcome!')
  }
}
```

`UserService` owns the `SmtpMailer`. This creates several problems:

- **Testing is hard.** You cannot swap the mailer for a fake in tests without
  changing the class itself.
- **Configuration is buried.** The SMTP host and port are hardcoded inside a
  class that should not know about infrastructure details.
- **Reuse is difficult.** If two services need the same mailer connection,
  each creates its own — there is no single shared instance unless you pass
  one around manually.

The manual fix is to inject the dependency through the constructor:

```ts
class UserService {
  constructor(private readonly mailer: Mailer) {}

  register(email: string): void {
    this.mailer.send(email, 'Welcome!')
  }
}

const mailer = new SmtpMailer('smtp.example.com', 587)
const users = new UserService(mailer)
```

This is dependency injection. `UserService` no longer owns `SmtpMailer` — it
receives it. You can now pass a `FakeMailer` in tests.

## Why use a container?

Manual injection works for small programs but does not scale. When you have
dozens of services, each with their own dependencies, the wiring code at the
top of the program becomes a large, hard-to-maintain construction graph.

A DI container automates this. You register what exists and how to build it;
the container resolves the construction order and manages instances:

```ts
const di = new CaffeineIoC()

di.bind(SmtpMailer, t => t.toValue(new SmtpMailer('smtp.example.com', 587)))
di.bind(UserService, t => t.toSelf([SmtpMailer]))

await di.init()

const users = di.get(UserService) // SmtpMailer injected automatically
```

Or with decorators, you co-locate the dependency declaration with the class:

```ts
@Injectable([SmtpMailer])
class UserService {
  constructor(private readonly mailer: SmtpMailer) {}
}
```

The container reads this at startup and wires the graph without any manual
construction code.

## What CaffeineIoC adds

CaffeineIoC is an IoC container for JavaScript and TypeScript. "IoC" stands for
Inversion of Control — instead of your code calling `new`, the container
controls construction.

Beyond basic injection, CaffeineIoC provides:

- **Scopes** — control how many instances exist (singleton, per-request,
  per-child-container).
- **Lifecycle hooks** — run code after construction (`@PostConstruct`), after
  every binding is resolved (`OnBootstrap`), and before shutdown (`OnDestroy`).
- **Profiles** — activate bindings only in specific environments.
- **Conditionals** — activate bindings based on arbitrary predicates.
- **Child containers** — create isolated sub-containers that inherit the
  parent's bindings.
- **Testing utilities** — snapshot and restore the binding registry for
  isolated tests.

See [Container lifecycle](./container-lifecycle.md) for how CaffeineIoC's startup and
shutdown sequence works, or start with the
[tutorial](../tutorial/request-scope-fastify) to see it in practice.
