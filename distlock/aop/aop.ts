import {
  type BootstrapKit,
  ErrFeatureNotInstalled,
  type Feature,
  type FeatureConfigureKit,
  kFeatureBootstrap,
  kFeatureConfigure,
  kFeatureName,
} from '@caffeinejs/application'
import { $aop, $i, type AnyClass, type JoinPoint, type MethodAspect, type Provider, reflect } from '@caffeinejs/di'
import { errMessage } from '@caffeinejs/std/err'

import type { DistLock } from '../distlock.js'
import type { Campaign } from '../election/election.js'
import { ErrDistLockConfiguration } from '../errors.js'
import { kDistLock } from '../keys.js'
import { LeaderOnly, type LeaderOnlyOptions } from './leader_only.js'
import { Once } from './once.js'
import { OneAtATime } from './one_at_a_time.js'

const ANNOTATIONS = [LeaderOnly, Once, OneAtATime] as const
const NAMES = new Map<unknown, string>([
  [LeaderOnly, 'LeaderOnly'],
  [Once, 'Once'],
  [OneAtATime, 'OneAtATime'],
])

function refused(problem: string, solution: string): ErrDistLockConfiguration {
  return new ErrDistLockConfiguration(
    errMessage(problem).solutions(solution).reference('@caffeinejs/distlock', ErrDistLockConfiguration).build(),
  )
}

// Refuses what would run unguarded or never run: a decorator the container cannot weave, and a guard on the key the
// method's own campaign holds while it leads.
function checkWeavable(cls: AnyClass): void {
  for (const annotation of ANNOTATIONS) {
    const name = NAMES.get(annotation)!
    const onStatic = reflect.members(cls, annotation, { static: true }).keys().next().value
    if (onStatic !== undefined) {
      throw refused(
        `Cannot weave "${cls.name}.${String(onStatic)}": @${name} is on a static method, which is never woven`,
        `Move @${name} to an instance method of "${cls.name}"`,
      )
    }
    for (const member of reflect.members(cls, annotation).keys()) {
      if (typeof member === 'string' && member.startsWith('#')) {
        throw refused(
          `Cannot weave "${cls.name}.${member}": @${name} is on a private method, which is never woven`,
          `Move @${name} to a public method of "${cls.name}" that the private one is called from`,
        )
      }
    }
  }

  for (const [member, leader] of reflect.members(cls, LeaderOnly)) {
    for (const guard of [Once, OneAtATime]) {
      if (reflect.effective(cls, guard, member)?.key === leader.key) {
        throw refused(
          `Cannot weave "${cls.name}.${String(member)}": @LeaderOnly and @${NAMES.get(guard)} both name key "${leader.key}", which the campaign holds while it leads, so the method would never run`,
          `Give @${NAMES.get(guard)} a key of its own, such as "${leader.key}:run"`,
        )
      }
    }
  }
}

// One pointcut for the three, so a method that carries several is woven once.
const pointcut = $aop.pointcut(
  (_descriptor, cls) => ANNOTATIONS.some(annotation => reflect.members(cls, annotation).size > 0),
  (member, _descriptor, cls) =>
    ANNOTATIONS.some(annotation => reflect.effective(cls, annotation, member) !== undefined),
)

/**
 * Runs each decorated method under the lock its decorators name: `@LeaderOnly` outermost, then `@Once`, then
 * `@OneAtATime`, whatever order they are written in. A call any of them skips resolves to `undefined`.
 */
export class DistLockAspect implements MethodAspect {
  // Optional, so the container initializes without it and bootstrap reports the missing feature instead.
  readonly #lock: Provider<DistLock | undefined>
  // One campaign per key, shared by every method that names it.
  readonly #campaigns = new Map<string, Campaign>()

  constructor(lock: Provider<DistLock | undefined>) {
    this.#lock = lock
  }

  around(joinPoint: JoinPoint): Promise<unknown> {
    const cls = joinPoint.ctor as AnyClass
    const member = joinPoint.methodName
    const leader = reflect.effective(cls, LeaderOnly, member)
    const once = reflect.effective(cls, Once, member)
    const alone = reflect.effective(cls, OneAtATime, member)
    const lock = this.#service()

    // A method that throws before returning its promise rejects, as an `async` one would.
    let run = (): Promise<unknown> => Promise.try(() => joinPoint.proceed(...joinPoint.args))

    if (alone !== undefined) {
      const inner = run
      run = () => lock.tryWithLock(alone.key, inner, alone.options).then(outcome => outcome.result)
    }
    if (once !== undefined) {
      const inner = run
      run = () => lock.once(once.key, inner, once.options).then(outcome => outcome.result)
    }
    if (leader !== undefined) {
      const inner = run
      const campaign = this.campaign(leader.key, leader.options)
      run = () => (campaign.isLeader ? inner() : Promise.resolve(undefined))
    }

    return run()
  }

  /** The campaign for `key`, started with `options` if none runs yet. */
  campaign(key: string, options: LeaderOnlyOptions): Campaign {
    let campaign = this.#campaigns.get(key)
    if (campaign === undefined) {
      campaign = this.#service().campaign(key, { ttl: options.ttl })
      this.#campaigns.set(key, campaign)
    }

    return campaign
  }

  // Bound whenever this aspect runs: bootstrap refuses an application without it.
  #service(): DistLock {
    return this.#lock.get()!
  }
}

/** The feature {@link DistLockAOP} installs. */
export class DistLockAOPBuilder implements Feature {
  get [kFeatureName](): string {
    return 'distlock:aop'
  }

  [kFeatureConfigure](kit: FeatureConfigureKit): void {
    kit.container.aspect(DistLockAspect, s => s.toSelf([$i.provide($i.optional(kDistLock))]).pointcuts(pointcut))
  }

  [kFeatureBootstrap](kit: BootstrapKit): void {
    if (!kit.container.has(kDistLock)) {
      throw new ErrFeatureNotInstalled(
        'distlock',
        'Install DistributedLock(d => d.backend(...)) from @caffeinejs/distlock next to DistLockAOP()',
      )
    }

    const classes = new Set<AnyClass>()
    for (const annotation of ANNOTATIONS) {
      for (const { binding } of kit.container.getBindingsByAnnotation(annotation)) {
        if (binding.type !== undefined) {
          classes.add(binding.type as AnyClass)
        }
      }
    }
    for (const cls of classes) {
      checkWeavable(cls)
    }

    // Every replica campaigns from start-up, so a leader is elected before the first call rather than by it.
    const aspect = kit.container.get(DistLockAspect)
    for (const { binding } of kit.container.getBindingsByAnnotation(LeaderOnly)) {
      if (binding.type === undefined) {
        continue
      }
      for (const { key, options } of reflect.members(binding.type as AnyClass, LeaderOnly).values()) {
        aspect.campaign(key, options)
      }
    }
  }
}

/**
 * Installs the `@Once`, `@OneAtATime` and `@LeaderOnly` decorators: the aspect that runs each decorated method of a
 * class the container builds under its lock. Install `DistributedLock(...)` beside it.
 *
 * Without this feature the decorators only write annotations, and nothing reads them: a decorated method runs as if
 * undecorated.
 *
 * @throws ErrFeatureNotInstalled at `bootstrap()` when `DistributedLock(...)` is not installed.
 * @example
 * ```ts
 * createApplication()
 *   .install(DistributedLock(d => d.backend(new RedisLockBackend(client))))
 *   .install(DistLockAOP())
 * ```
 */
export function DistLockAOP(): Feature {
  return new DistLockAOPBuilder()
}
