# Annotations

Annotations attach typed metadata to classes and class members with decorators, and `reflect` reads it
back. Use them to declare routes, schedule jobs, map columns, guard methods or select methods for an aspect.

Everything on this page comes from the core package:

```ts
import { createAnnotation, reflect } from '@caffeinejs/di'
```

## Create an annotation

`createAnnotation<V>()` returns a decorator factory. The value you pass when you apply it is what `reflect`
reads back, and the factory itself is the key you read it with.

```ts
const Owner = createAnnotation<string>()

@Owner('payments')
class Billing {
  @Owner('fraud')
  review() {}
}

reflect.get(Billing, Owner) // 'payments'
reflect.get(Billing, Owner, 'review') // 'fraud'
```

Without a value type, the annotation is a marker: it takes no argument and stores `true`.

```ts
const Deprecated = createAnnotation()

class Payments {
  @Deprecated()
  legacyCharge() {}
}

reflect.get(Payments, Deprecated, 'legacyCharge') // true
```

A transform gives the decorator its own arguments and turns them into the stored value:

```ts
interface CacheOptions {
  ttl: number
  stale: boolean
}

const Cache = createAnnotation((options: Partial<CacheOptions> = {}): CacheOptions => ({
  ttl: 30,
  stale: false,
  ...options,
}))

class Catalog {
  @Cache()
  list() {}

  @Cache({ ttl: 60 })
  find() {}
}

reflect.get(Catalog, Cache, 'list') // { ttl: 30, stale: false }
reflect.get(Catalog, Cache, 'find') // { ttl: 60, stale: false }
```

## Choose where it applies

`createAnnotation.on(...targets)` restricts an annotation to the class, or to some kinds of member:
`'class'`, `'method'`, `'field'`, `'accessor'`, `'getter'` and `'setter'`. Applying it anywhere else is a
type error. From plain JavaScript or through a cast, it throws `ErrInvalidDecorator` when the class is
defined.

```ts
const Entity = createAnnotation.on('class')<{ table: string }>()
const Column = createAnnotation.on('field')<{ type: string }>()
const Route = createAnnotation.on('method')((path: string) => ({ path }))
const Secured = createAnnotation.on('class', 'method')<string[]>()

@Entity({ table: 'users' })
@Secured(['user'])
class Users {
  @Column({ type: 'text' })
  name = ''

  @Route('/users')
  @Secured(['admin'])
  list() {}
}
```

Reads follow the same rule: reading a class-only annotation at member level, or a method-only annotation
at class level, is a type error.

## Apply an annotation more than once

Applying an annotation twice to the same class or member throws `ErrInvalidDecorator`. Create it with
`{ repeatable: true }` to collect every value instead, in the order they are written:

```ts
const Tags = createAnnotation<string>({ repeatable: true })

@Tags('billing')
@Tags('v2')
class Invoices {}

reflect.get(Invoices, Tags) // ['billing', 'v2']
```

## Inheritance and merge rules

A subclass reads its base class's annotations, and the nearest declaration wins. `inherit` changes that
for one annotation:

- `'own'` reads only what the class itself declares.
- `'accumulate'` folds every declaration, from the farthest base class to the class, with `combine`.

```ts
const Permissions = createAnnotation.on('class')<string[]>({
  inherit: 'accumulate',
  combine: (outer, inner) => [...outer, ...inner],
})

@Permissions(['read'])
class Resource {}

@Permissions(['write'])
class Documents extends Resource {}

reflect.get(Documents, Permissions) // ['read', 'write']
```

`combine(outer, inner)` also decides what `reflect.effective` returns when both a class value and a member
value exist. Without it, the member value wins.

```ts
interface Timeouts {
  connect: number
  read: number
}

// `.on(...)` returns a factory; keep it to create several annotations with the same targets
const onClassOrMethod = createAnnotation.on('class', 'method')

const Timeout = onClassOrMethod<Partial<Timeouts>>({
  combine: (outer, inner) => ({ ...outer, ...inner }),
})

@Timeout({ connect: 1000, read: 5000 })
class Client {
  @Timeout({ read: 30000 })
  download() {}
}

reflect.effective(Client, Timeout, 'download') // { connect: 1000, read: 30000 }
```

## Static members

A static member and an instance member with the same name keep separate values. Pass `{ static: true }` to
address the static one:

```ts
class Jobs {
  @Route('/jobs/run-all')
  static run() {}

  @Route('/jobs/run')
  run() {}
}

reflect.get(Jobs, Route, 'run') // { path: '/jobs/run' }
reflect.get(Jobs, Route, 'run', { static: true }) // { path: '/jobs/run-all' }
```

## Write the decorator yourself

When the targets cannot express a rule, such as async methods only, number fields only, or a handler that
must accept an event's payload, write the decorator with the signature that enforces it. Make it its own
key by declaring its type as an intersection with `Annotation`:

```ts
import { type Annotation, reflect } from '@caffeinejs/di'

type AsyncMethod = (...args: any[]) => Promise<unknown>

const Retry: ((
  attempts: number,
) => (target: AsyncMethod, context: ClassMethodDecoratorContext<unknown, AsyncMethod>) => void) &
  Annotation<number, 'method'> = attempts => (_target, context) => {
  reflect.annotate(context, Retry, attempts)
}

class Gateway {
  @Retry(3)
  async fetch() {}
}

reflect.get(Gateway, Retry, 'fetch') // 3
```

`@Retry` on a method that is not async is now a type error, and `reflect.annotate` checks the value against
`number`. A plain `function Retry(...)` cannot be its own key, because a function declaration cannot carry
the annotation's types. Declare the intersection as above.

## Read annotations

- `reflect.get(target, key)` returns the class value. `reflect.get(target, key, member)` returns that
  member's value, without falling back to the class value.
- `reflect.effective(target, key, member)` returns the member value, otherwise the class value, joined by
  the annotation's `combine` rule.
- `reflect.merge(target, key, member)` concatenates the class array and the member array.
- `reflect.members(target, key)` lists every member that carries the annotation, by name, base class
  members included.

```ts
class Row {
  @Column({ type: 'int' })
  id = 0

  @Column({ type: 'text' })
  title = ''
}

reflect.members(Row, Column) // Map { 'id' => { type: 'int' }, 'title' => { type: 'text' } }
```

Read from the class, not from an instance: an instance does not read its class's annotations. Pass
`instance.constructor` instead.

## Read while decorating

A class's metadata is attached only after its class decorators run. Inside a class decorator, read
through its context instead of the class. The context sees what the class's decorators have written so
far: every member decorator, and every class decorator written below it. It never sees a base class.

```ts
import { type AnyClass, ErrInvalidDecorator, reflect } from '@caffeinejs/di'

const Controller = () => (_target: AnyClass, context: ClassDecoratorContext) => {
  if (reflect.members(context, Route).size === 0) {
    throw new ErrInvalidDecorator(`Cannot apply @Controller to class "${String(context.name)}": it has no @Route`)
  }
}
```

## Write outside a decorator

`reflect.set(target, key, value, member?)` writes without a decorator: on a class configured in code, on a
function, or on any other object.

```ts
const router = {}

reflect.set(router, Route, { path: '/health' }, 'health')

reflect.get(router, Route, 'health') // { path: '/health' }
```

## Find annotated classes

`container.getBindingsByAnnotation(key)` returns the bindings whose class carries the annotation, on the
class or on any member. A scheduler finds its jobs this way:

```ts
const Cron = createAnnotation.on('method')<string>()

for (const { binding } of container.getBindingsByAnnotation(Cron)) {
  for (const [method, expression] of reflect.members(binding.type!, Cron)) {
    scheduler.add(expression, binding, method)
  }
}
```

Like every container lookup, it finds nothing before the container compiles.

## Use annotations in aspects

`$aop.annotatedWith(key)` selects what an annotation covers: every method annotated with it, and every
method of a class annotated with it.

```ts
import { $aop, Aspect, createAnnotation, type JoinPoint, type MethodAspect } from '@caffeinejs/di'

const Audited = createAnnotation.on('class', 'method')()

@Aspect([$aop.annotatedWith(Audited)])
class AuditAspect implements MethodAspect {
  before(joinPoint: JoinPoint) {
    console.info('calling', joinPoint.methodName)
  }
}
```

## Use a symbol as the key

A symbol works as a key too. Give the value type at the read:

```ts
import { type AnyClass, reflect } from '@caffeinejs/di'

const kVersion = Symbol('version')

const Version = (version: number) => (_target: AnyClass, context: ClassDecoratorContext) => {
  reflect.annotate(context, kVersion, version)
}

@Version(2)
class Accounts {}

reflect.get<number>(Accounts, kVersion) // 2
```
