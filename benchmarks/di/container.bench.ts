/* oxlint-disable no-empty-function -- bench stubs */
/* oxlint-disable no-unused-vars -- decorator-registered fixtures */
import {
  $i,
  CaffeineIoC,
  ConditionalOn,
  Configuration,
  Extends,
  Inject,
  Injectable,
  Lifetime,
  Named,
  Order,
  Primary,
  type Provider,
  Provides,
  Scopes,
  token,
} from '@caffeinejs/di'
import { bench, do_not_optimize, group, run, summary } from 'mitata'

const kDbURL = token<string>(Symbol('db_url'))

@Configuration()
class DbConf {
  @Provides(kDbURL)
  dbURL(): string {
    return 'test_db'
  }
}

@Injectable([kDbURL])
class Db {
  constructor(readonly dbURL: string) {}
}

interface Repo {
  fetch(): string
}

@Injectable([Db])
class RepoDb implements Repo {
  constructor(readonly db: Db) {}

  fetch(): string {
    return this.db.dbURL
  }
}

interface Notification {
  send(): void
}

const kNotification = token<Notification>(Symbol('notification'))

@Injectable(kNotification)
@Primary()
class EmailNotification implements Notification {
  send(): void {}
}

@Injectable(kNotification)
class SmsNotification implements Notification {
  send(): void {}
}

abstract class Act {
  abstract act(): void
}

@Injectable()
@Extends()
class Act1 extends Act {
  act(): void {}
}

@Injectable()
@ConditionalOn(() => false)
class Maybe {}

const kLog = token<Logger>(Symbol('log'))

interface Logger {
  info(): void
}

@Injectable()
@Named(kLog)
class TxtLogger implements Logger {
  info(): void {}
}

@Injectable()
@Named(kLog)
class StdLogger implements Logger {
  info(): void {}
}

@Injectable()
@Named(kLog)
class JSONLogger implements Logger {
  info(): void {}
}

@Injectable()
class Simple {}

@Injectable([RepoDb, kNotification, Act, $i.allOf(kLog), $i.optional(Maybe)])
class Root {
  constructor(
    readonly repo: Repo,
    readonly notification: Notification,
    readonly act: Act,
    readonly loggers: Logger[],
    readonly maybe?: Maybe,
  ) {}
}

@Injectable([Act, $i.allOf(kLog), $i.optional(Maybe)])
class RootWithMethodInjection {
  repo!: Repo
  notification!: Notification

  constructor(
    readonly act: Act,
    readonly loggers: Logger[],
    readonly maybe?: Maybe,
  ) {}

  @Inject([RepoDb, kNotification])
  setDeps(repo: Repo, notification: Notification) {
    this.repo = repo
    this.notification = notification
  }
}

@Injectable([Act, $i.allOf(kLog), $i.optional(Maybe)])
class RootWithAll {
  repo!: Repo

  @Inject(kNotification)
  notification!: Notification

  constructor(
    readonly act: Act,
    readonly loggers: Logger[],
    readonly maybe?: Maybe,
  ) {}

  @Inject([RepoDb])
  setDeps(repo: Repo) {
    this.repo = repo
  }
}

// Transient graph — isolated from the singleton graph above

@Injectable()
@Lifetime(Scopes.TRANSIENT)
class DbT {
  readonly dbURL = 'test_db'
}

@Injectable([DbT])
@Lifetime(Scopes.TRANSIENT)
class RepoDbT implements Repo {
  constructor(readonly db: DbT) {}

  fetch(): string {
    return this.db.dbURL
  }
}

const kNotificationT = token<Notification>(Symbol('notification_t'))

@Injectable(kNotificationT)
@Primary()
@Lifetime(Scopes.TRANSIENT)
class EmailNotificationT implements Notification {
  send(): void {}
}

@Injectable(kNotificationT)
@Lifetime(Scopes.TRANSIENT)
class SmsNotificationT implements Notification {
  send(): void {}
}

abstract class ActT {
  abstract act(): void
}

@Injectable()
@Extends()
@Lifetime(Scopes.TRANSIENT)
class Act1T extends ActT {
  act(): void {}
}

const kLogT = token<Logger>(Symbol('log_t'))

@Injectable()
@Named(kLogT)
@Lifetime(Scopes.TRANSIENT)
class TxtLoggerT implements Logger {
  info(): void {}
}

@Injectable()
@Named(kLogT)
@Lifetime(Scopes.TRANSIENT)
class StdLoggerT implements Logger {
  info(): void {}
}

@Injectable()
@Named(kLogT)
@Lifetime(Scopes.TRANSIENT)
class JSONLoggerT implements Logger {
  info(): void {}
}

@Injectable([RepoDbT, kNotificationT, ActT, $i.allOf(kLogT), $i.optional(Maybe)])
@Lifetime(Scopes.TRANSIENT)
class RootTransient {
  constructor(
    readonly repo: Repo,
    readonly notification: Notification,
    readonly act: ActT,
    readonly loggers: Logger[],
    readonly maybe?: Maybe,
  ) {}
}

@Injectable([RepoDb, Act, $i.allOf(kLog), $i.optional(Maybe)])
class RootWithProps {
  @Inject(kNotification)
  notification!: Notification

  constructor(
    readonly repo: Repo,
    readonly act: Act,
    readonly loggers: Logger[],
    readonly maybe?: Maybe,
  ) {}
}

@Injectable()
@Lifetime(Scopes.TRANSIENT)
class Dep1 {}

@Injectable()
@Lifetime(Scopes.TRANSIENT)
class Dep2 {}

@Injectable([
  $i.object({
    dep1: Dep1,
    dep2: $i.optional(Dep2),
    nested: { inner: Dep1 },
  }),
])
@Lifetime(Scopes.TRANSIENT)
class DestructuringRoot {
  constructor(readonly args: { dep1: Dep1; dep2?: Dep2; nested: { inner: Dep1 } }) {}
}

@Injectable([Act, $i.allOf(kLog), $i.optional(Maybe)])
class RootWith2Props {
  @Inject(kNotification)
  notification!: Notification

  @Inject(RepoDb)
  repo!: RepoDb

  constructor(
    readonly act: Act,
    readonly loggers: Logger[],
    readonly maybe?: Maybe,
  ) {}
}

// Injection helpers that the groups above never touch. The consumers are transient on purpose: a singleton
// consumer is resolved from cache, so its injection resolvers run once and the bench measures the cache lookup
// instead of the resolver.

interface Plugin {
  id(): string
}

const kPlug = token<Plugin>(Symbol('plugin'))

@Injectable(kPlug)
@Named('alpha')
@Order(2)
class PlugAlpha implements Plugin {
  id(): string {
    return 'alpha'
  }
}

@Injectable(kPlug)
@Named('beta')
@Order(1)
class PlugBeta implements Plugin {
  id(): string {
    return 'beta'
  }
}

@Injectable(kPlug)
@Named('gamma')
@Order(3)
class PlugGamma implements Plugin {
  id(): string {
    return 'gamma'
  }
}

@Injectable([$i.ordered(kPlug)])
@Lifetime(Scopes.TRANSIENT)
class OrderedRoot {
  constructor(readonly plugins: Plugin[]) {}
}

@Injectable([$i.mapped(kPlug)])
@Lifetime(Scopes.TRANSIENT)
class MappedRoot {
  constructor(readonly plugins: Map<string, Plugin>) {}
}

@Injectable([$i.provide(DbT)])
@Lifetime(Scopes.TRANSIENT)
class ProvideRoot {
  constructor(readonly db: Provider<DbT>) {}
}

@Injectable([$i.allOf($i.provide(kPlug))])
@Lifetime(Scopes.TRANSIENT)
class AllOfProvideRoot {
  constructor(readonly plugins: Provider<Plugin[]>) {}
}

@Injectable([$i.defer(() => Db)])
@Lifetime(Scopes.TRANSIENT)
class DeferRoot {
  constructor(readonly db: Db) {}
}

// Held as a singleton so the bench below times Provider.get() alone, not the injection that produced it.
@Injectable([$i.provide(DbT)])
class ProvideHolder {
  constructor(readonly db: Provider<DbT>) {}
}

class Undecorated {}

const di = new CaffeineIoC()
await di.init()

const provideHolder = di.get(ProvideHolder)

// Every case binds into a container built for that iteration, outside the timed region, with keys made up front.
// One shared container would grow by a binding per iteration, so each case would run against whatever the ones
// before it left behind, and the key's construction would be timed along with the bind.
const kBindSym = token<number>(Symbol('bind_sym'))
const kBindStr = token<number>('bind_str')
const kBindFactory = token<number>('bind_factory')
const emptyContainer = (): CaffeineIoC => new CaffeineIoC({ decorators: false })

group('bindings', () => {
  summary(() => {
    bench('toValue str key', function* () {
      yield {
        [0]: emptyContainer,
        bench: (c: CaffeineIoC) => c.bind(kBindStr, t => t.toValue(1)),
      }
    })
    bench('toValue sym key', function* () {
      yield {
        [0]: emptyContainer,
        bench: (c: CaffeineIoC) => c.bind(kBindSym, t => t.toValue(1)),
      }
    })
    bench('toSelf', function* () {
      yield {
        [0]: emptyContainer,
        bench: (c: CaffeineIoC) => c.bind(Undecorated, t => t.toSelf()),
      }
    })
    bench('toFactory', function* () {
      yield {
        [0]: emptyContainer,
        bench: (c: CaffeineIoC) => c.bind(kBindFactory, t => t.toFactory(() => 1)),
      }
    })
    // A chain with modifiers, which is what production binding code actually looks like. The other cases in this
    // group configure nothing, so they do not show what a multi-step chain costs.
    bench('toSelf chained', function* () {
      yield {
        [0]: emptyContainer,
        bench: (c: CaffeineIoC) =>
          c.bind(Undecorated, t => t.toSelf().lifetime(Scopes.SINGLETON).names('chained').lazy().internal()),
      }
    })
  })
})

await run()
