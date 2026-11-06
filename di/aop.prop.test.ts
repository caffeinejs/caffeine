import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'

import { $aop, type JoinPoint, type MethodAspect } from './aop.js'
import { CaffeineIoC } from './container.js'
import { ErrInvalidAspect } from './errors.js'

type Key = string | symbol
type Kind = 'method' | 'async' | 'generator' | 'getter' | 'accessor' | 'setter' | 'arrow' | 'bound'
type Lock = 'none' | 'preventExtensions' | 'freeze'
type Instance = Record<Key, any>

interface Member {
  readonly key: Key
  readonly kind: Kind
  /** Declared on the base class rather than the class itself. Own members (`arrow`) ignore it. */
  readonly onBase: boolean
  /** A getter or an accessor that hands out a function rather than a value. */
  readonly returnsFunction: boolean
  /**
   * A member of the base class under the same key, which this one shadows when it sits on the class or the instance.
   * Weaving must go by the nearest declaration, not by the first function it finds up the chain.
   */
  readonly shadows: Kind | null
}

interface Shape {
  readonly members: readonly Member[]
  /** The members a named pointcut lists, or `null` for a pointcut that covers every method of the class. */
  readonly named: readonly Key[] | null
  readonly lock: Lock
}

// What each instance saw, kept on the instance under a symbol no pointcut can name, so a twin and a woven instance
// built from one class never share it.
const LOG = Symbol('log')

interface Log {
  readonly reads: Map<Key, number>
  readonly sets: Map<Key, number>
  readonly stored: Map<Key, unknown>
  readonly receivers: unknown[]
}

const symbols = [Symbol('s0'), Symbol('s1'), Symbol('s2')]
const DATA_METHODS: ReadonlySet<Kind> = new Set<Kind>(['method', 'async', 'generator', 'bound', 'arrow'])
const OWN: ReadonlySet<Kind> = new Set<Kind>(['bound', 'arrow'])

const member = fc.record({
  key: fc.constantFrom<Key>('m0', 'm1', 'm2', 'm3', 'm4', ...symbols),
  kind: fc.constantFrom<Kind>('method', 'async', 'generator', 'getter', 'accessor', 'setter', 'arrow', 'bound'),
  onBase: fc.boolean(),
  returnsFunction: fc.boolean(),
  shadows: fc.option(fc.constantFrom<Kind>('method', 'getter', 'accessor', 'setter'), { nil: null }),
})

const shape: fc.Arbitrary<Shape> = fc
  .record({
    members: fc.uniqueArray(member, { minLength: 1, maxLength: 8, selector: m => m.key }),
    picks: fc.option(fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }), { nil: null }),
    lock: fc.constantFrom<Lock>('none', 'preventExtensions', 'freeze'),
  })
  .map(({ members, picks, lock }) => ({
    members,
    named: picks === null ? null : members.filter((_, i) => picks[i]).map(m => m.key),
    lock,
  }))

function id(m: Member): string {
  return `${m.kind}:${String(m.key)}`
}

// The base class member `m` shadows, if any: only one declared nearer, on the class or the instance, shadows it.
function shadowed(m: Member): Member | undefined {
  if (m.shadows === null || (m.onBase && m.kind !== 'arrow')) {
    return undefined
  }
  return { ...m, kind: m.shadows, onBase: true, shadows: null }
}

function log(instance: Instance): Log {
  return instance[LOG] as Log
}

function count(map: Map<Key, number>, key: Key): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

// The value a getter or an accessor holds: a function only when the member hands out functions.
function held(m: Member, value: string): unknown {
  return m.returnsFunction ? () => value : value
}

function build(s: Shape): new () => Instance {
  class Base {}
  class Target extends Base {
    constructor() {
      super()
      const self = this as Instance
      const entry: Log = { reads: new Map(), sets: new Map(), stored: new Map(), receivers: [] }
      Object.defineProperty(this, LOG, { value: entry })
      for (const m of s.members) {
        if (m.kind === 'arrow') {
          // As a class field does: defined, not assigned, so an accessor of the base class never sees it.
          Object.defineProperty(this, m.key, {
            value: () => id(m),
            writable: true,
            enumerable: true,
            configurable: true,
          })
        } else if (m.kind === 'bound') {
          self[m.key] = (self[m.key] as Function).bind(this)
        }
      }
      if (s.lock === 'freeze') {
        Object.freeze(this)
      } else if (s.lock === 'preventExtensions') {
        Object.preventExtensions(this)
      }
    }
  }

  const declarations = s.members.flatMap(m => {
    const base = shadowed(m)
    return base === undefined ? [m] : [m, base]
  })
  for (const m of declarations) {
    const home = (m.onBase ? Base : Target).prototype
    const value = `${m.onBase ? 'base' : 'class'}:${id(m)}`
    const method = (descriptor: PropertyDescriptor) =>
      Object.defineProperty(home, m.key, { ...descriptor, writable: true, enumerable: false, configurable: true })
    const accessor = (descriptor: PropertyDescriptor) =>
      Object.defineProperty(home, m.key, { ...descriptor, enumerable: false, configurable: true })

    switch (m.kind) {
      case 'method':
      case 'bound':
        method({
          value: function (this: Instance) {
            log(this).receivers.push(this)
            return value
          },
        })
        break
      case 'async':
        method({
          value: async function (this: Instance) {
            log(this).receivers.push(this)
            return value
          },
        })
        break
      case 'generator':
        method({
          value: function* (this: Instance) {
            log(this).receivers.push(this)
            yield value
          },
        })
        break
      case 'getter':
        accessor({
          get(this: Instance) {
            count(log(this).reads, m.key)
            return held(m, value)
          },
        })
        break
      case 'accessor':
        accessor({
          get(this: Instance) {
            count(log(this).reads, m.key)
            return log(this).stored.has(m.key) ? log(this).stored.get(m.key) : held(m, value)
          },
          set(this: Instance, next: unknown) {
            count(log(this).sets, m.key)
            log(this).stored.set(m.key, next)
          },
        })
        break
      case 'setter':
        accessor({
          set(this: Instance) {
            count(log(this).sets, m.key)
          },
        })
        break
      case 'arrow':
        break
    }
  }
  return Target as unknown as new () => Instance
}

// A method the pointcut covers: every data method the class declares, or each data method the pointcut names,
// including one an instance holds. Never an accessor.
function advised(s: Shape, m: Member): boolean {
  if (!DATA_METHODS.has(m.kind)) {
    return false
  }
  if (s.named !== null) {
    return s.named.includes(m.key)
  }
  // A pointcut that covers the class reaches every key its prototypes declare, whatever the instance holds there.
  return m.kind !== 'arrow' || shadowed(m) !== undefined
}

// Uses a member the way a caller does and returns what the caller gets back.
async function use(instance: Instance, m: Member): Promise<unknown> {
  const unwrap = (v: unknown) => (typeof v === 'function' ? (v as () => unknown)() : v)
  switch (m.kind) {
    case 'method':
    case 'bound':
    case 'arrow':
      return instance[m.key]()
    case 'async':
      return await instance[m.key]()
    case 'generator':
      return [...instance[m.key]()]
    case 'getter':
      return unwrap(instance[m.key])
    case 'accessor':
      instance[m.key] = held(m, 'assigned')
      return unwrap(instance[m.key])
    case 'setter':
      instance[m.key] = 'assigned'
      return instance[m.key]
  }
}

// Weaving must change what an advised method call does, by running its advice, and nothing else about the instance.
describe('weaving an aspect into an instance of any shape', () => {
  it.prop([shape], { numRuns: 200 })(
    'reads no accessor, advises each covered method once per call, and leaves every other member as it was',
    async s => {
      const Target = build(s)
      const calls: Key[] = []
      class Recorder implements MethodAspect {
        before(jp: JoinPoint) {
          calls.push(jp.methodName)
        }
      }
      const di = new CaffeineIoC({ decorators: false })
      di.bind(Target, t => t.toSelf())
      di.aspect(Recorder, t =>
        t.toSelf().pointcuts(s.named === null ? $aop.forClass(Target) : $aop.forClass(Target, [...s.named])),
      )
      const resolve = async () => {
        await di.init()
        return di.get(Target)
      }

      // A frozen instance's own method can be neither replaced nor proxied: resolving it must refuse.
      if (s.lock === 'freeze' && s.members.some(m => OWN.has(m.kind) && advised(s, m))) {
        await expect(resolve()).rejects.toThrow(ErrInvalidAspect)
        return
      }

      const instance = await resolve()
      const twin = new Target()

      expect(Object.fromEntries(log(instance).reads)).toEqual({})

      const expected: Key[] = []
      for (const m of s.members) {
        const got = await use(instance, m)
        expect(got).toEqual(await use(twin, m))
        if (advised(s, m)) {
          expected.push(m.key)
        }
        if (m.kind === 'method' || m.kind === 'async' || m.kind === 'generator') {
          expect(log(instance).receivers.at(-1)).toBe(instance)
        }
      }

      expect(calls).toEqual(expected)
      expect([...log(instance).reads]).toEqual([...log(twin).reads])
      expect([...log(instance).sets]).toEqual([...log(twin).sets])
      expect(Object.keys(instance)).toEqual(Object.keys(twin))
      expect(JSON.stringify(instance)).toBe(JSON.stringify(twin))
    },
  )
})
