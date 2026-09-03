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
import { bench, do_not_optimize, group, run } from 'mitata'

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

const kBindSym = token<number>(Symbol('bind_sym'))
const diForBindings = new CaffeineIoC()
let bindSeq = 0

group('resolutions', () => {
  bench('class simple', () => di.get(Simple))
  bench('class ctor deps', () => di.get(Root))
  bench('class ctor deps tr', () => di.get(RootTransient))
  bench('class ctor props', () => di.get(RootWithProps))
  bench('class ctor 2 props', () => di.get(RootWith2Props))
  bench('class ctor method', () => di.get(RootWithMethodInjection))
  bench('class ctor method props', () => di.get(RootWithAll))
  bench('many', () => di.getMany(kLog))
  bench('optional miss', () => di.getBinding(Maybe))
  bench('abstract', () => di.get(Act))
  bench('primary', () => di.get(kNotification))
  bench('class destructuring', () => di.get(DestructuringRoot))
  bench('bean - string value', () => di.get(kDbURL))
  bench('ordered', () => di.get(OrderedRoot))
  bench('mapped', () => di.get(MappedRoot))
  bench('provide', () => di.get(ProvideRoot))
  // do_not_optimize: the resolved instance is otherwise unused and V8 eliminates the whole call.
  bench('provide get()', () => do_not_optimize(provideHolder.db.get()))
  bench('allOf provide', () => di.get(AllOfProvideRoot))
  bench('defer', () => di.get(DeferRoot))
})

group('bindings', () => {
  bench('toValue str key', () => diForBindings.bind(token<number>(`bk_${bindSeq++}`), t => t.toValue(bindSeq)))
  bench('toValue sym key', () => diForBindings.bind(kBindSym, t => t.toValue(bindSeq)))
  bench('toSelf', () => diForBindings.bind(Undecorated, t => t.toSelf()))
  bench('toFactory', () => diForBindings.bind(token<number>(`bf_${bindSeq++}`), t => t.toFactory(() => bindSeq)))
  // A chain with modifiers, which is what production binding code actually looks like. The other cases in this
  // group configure nothing, so they do not show what a multi-step chain costs.
  bench('toSelf chained', () =>
    diForBindings.bind(Undecorated, t =>
      t.toSelf().lifetime(Scopes.SINGLETON).names(`n_${bindSeq++}`).lazy().internal(),
    ))
})

const { benchmarks } = await run()

const fmtNs = (ns: number): string => {
  if (ns < 1_000) {
    return `${ns.toFixed(2)} ns`
  }
  if (ns < 1_000_000) {
    return `${(ns / 1_000).toFixed(2)} µs`
  }
  return `${(ns / 1_000_000).toFixed(2)} ms`
}

const entries = benchmarks
  .flatMap(t => t.runs)
  .filter(r => r.stats != null)
  .map(r => ({ name: r.name, avg: r.stats!.avg }))
  .sort((a, b) => a.avg - b.avg)

const maxName = Math.max(...entries.map(e => e.name.length))

console.log('\n--- sorted fastest → slowest ---')
entries.forEach((e, i) => {
  const rank = String(i + 1).padStart(2)
  const name = e.name.padEnd(maxName)
  console.log(`${rank}. ${name}  ${fmtNs(e.avg)}`)
})
