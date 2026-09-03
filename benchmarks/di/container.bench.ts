/* eslint-disable @typescript-eslint/no-empty-function -- bench stubs */
/* eslint-disable @typescript-eslint/no-unused-vars -- decorator-registered fixtures */
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
  Primary,
  Provides,
  Scopes,
  token,
} from '@caffeinejs/di'
import { bench, group, run } from 'mitata'

const kDbURL = token<any>(Symbol('db_url'))

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

const kNotification = token<any>(Symbol('notification'))

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

const kLog = token<any>(Symbol('log'))

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

const kNotificationT = token<any>(Symbol('notification_t'))

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

const kLogT = token<any>(Symbol('log_t'))

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
  constructor(readonly args: { dep1: Dep1, dep2?: Dep2, nested: { inner: Dep1 } }) {}
}

@Injectable([Act, $i.allOf(kLog), $i.optional(Maybe)])
class RootWith2Props {
  @Inject(kNotification)
  notification!: Notification

  @Inject(RepoDb)
  repo!: Repo

  constructor(
    readonly act: Act,
    readonly loggers: Logger[],
    readonly maybe?: Maybe,
  ) {}
}

class Undecorated {}

const di = new CaffeineIoC()
await di.init()

const kBindSym = token<any>(Symbol('bind_sym'))
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
})

group('bindings', () => {
  bench('toValue str key', () => diForBindings.bind(token<number>(`bk_${bindSeq++}`)).toValue(bindSeq))
  bench('toValue sym key', () => diForBindings.bind(kBindSym).toValue(bindSeq))
  bench('toSelf', () => diForBindings.bind(Undecorated).toSelf())
  bench('toFactory', () => diForBindings.bind(token<number>(`bf_${bindSeq++}`)).toFactory(() => bindSeq))
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
