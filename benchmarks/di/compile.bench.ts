/* oxlint-disable no-empty-function -- bench stubs */
// Boot-path benchmark: container construction, binding registration and compile() at a realistic binding
// count. The 3-60 ns cases in container.bench.ts cannot show boot cost; these run at millisecond scale, where
// a super-linear scan in compile() is visible.
//
// Classes and their dependency wiring are built once, outside the measured region — only container
// construction, the bind() calls and compile() are timed, because a fresh container is required per
// iteration (compile() is a no-op the second time).
import { $aop, CaffeineIoC, type Ctor, type JoinPoint, type MethodAspect } from '@caffeinejs/di'
import { bench, group, run } from 'mitata'

const kBeanTag = Symbol('bench:bean-tag')
const kBeanLabel = Symbol('bench:bean-label')

interface Bean {
  findOne(): number
  saveOne(): number
}

type BeanCtor = Ctor<Bean, any[]>

// A distinct class per binding, so `binding.type` is unique and the weaving map is keyed the way a real
// application keys it. `name` is set for readable failures.
//
// Parameters are declared rather than collected with a rest element: the container arity-checks a binding
// against `ctor.length`, and a rest parameter reports 0.
function makeBeanClass(name: string, roots: boolean): BeanCtor {
  const C = roots
    ? class {
        findOne(): number {
          return 0
        }

        saveOne(): number {
          return 1
        }
      }
    : class {
        constructor(
          readonly a: unknown,
          readonly b: unknown,
        ) {}

        findOne(): number {
          return this.a === undefined ? 0 : 1
        }

        saveOne(): number {
          return this.b === undefined ? 0 : 1
        }
      }

  Object.defineProperty(C, 'name', { value: name })

  return C as BeanCtor
}

function makeAspectClass(name: string): Ctor<MethodAspect<Bean>, []> {
  const C = class implements MethodAspect<Bean> {
    around(jp: JoinPoint<Bean>): unknown {
      return jp.proceed(...jp.args)
    }
  }

  Object.defineProperty(C, 'name', { value: name })

  return C as Ctor<MethodAspect<Bean>, []>
}

interface Fixture {
  classes: BeanCtor[]
  deps: BeanCtor[][]
  aspects: Ctor<MethodAspect<Bean>, []>[]
}

// Each bean depends on the two declared before it, giving a fan-out of 2 and a deep-but-acyclic graph — the
// shape checkCircularReferences, checkScopes and the scope-graph walks actually traverse.
function fixture(n: number, aspectCount: number): Fixture {
  const classes: BeanCtor[] = []
  const deps: BeanCtor[][] = []

  for (let i = 0; i < n; i++) {
    classes.push(makeBeanClass(`Bean${i}`, i < 2))
    deps.push(i >= 2 ? [classes[i - 1], classes[i - 2]] : [])
  }

  const aspects: Ctor<MethodAspect<Bean>, []>[] = []
  for (let a = 0; a < aspectCount; a++) {
    aspects.push(makeAspectClass(`BenchAspect${a}`))
  }

  return { classes, deps, aspects }
}

// Predicate pointcuts (not $aop.forClass) are the case that scans the registry. Both match a narrow slice, so
// the scan cost stays visible without the weaving cost of proxying every bean drowning it out.
function compileOnce(f: Fixture): Promise<void> {
  const di = new CaffeineIoC({ decorators: false })

  for (let i = 0; i < f.classes.length; i++) {
    const C = f.classes[i]
    di.bind(C, t =>
      t
        .toClass(C, f.deps[i] as never)
        .labels(kBeanLabel)
        .tags(kBeanTag, i % 8),
    )
  }

  for (let a = 0; a < f.aspects.length; a++) {
    const A = f.aspects[a]
    di.aspect(A, t =>
      t
        .toSelf()
        .pointcuts(
          $aop.pointcut($aop.matchTag(kBeanTag, a % 8), 'findOne'),
          $aop.pointcut($aop.matchTag(kBeanTag, (a + 4) % 8), 'saveOne'),
        ),
    )
  }

  return di.compile()
}

async function bootOnce(f: Fixture): Promise<void> {
  const di = new CaffeineIoC({ decorators: false })

  for (let i = 0; i < f.classes.length; i++) {
    const C = f.classes[i]
    di.bind(C, t =>
      t
        .toClass(C, f.deps[i] as never)
        .labels(kBeanLabel)
        .tags(kBeanTag, i % 8),
    )
  }

  for (let a = 0; a < f.aspects.length; a++) {
    const A = f.aspects[a]
    di.aspect(A, t =>
      t
        .toSelf()
        .pointcuts(
          $aop.pointcut($aop.matchTag(kBeanTag, a % 8), 'findOne'),
          $aop.pointcut($aop.matchTag(kBeanTag, (a + 4) % 8), 'saveOne'),
        ),
    )
  }

  await di.init()
  await di.dispose()
}

const SIZES = [200, 1000, 2000]

const plain = new Map(SIZES.map(n => [n, fixture(n, 0)]))
const withAspects = new Map(SIZES.map(n => [n, fixture(n, 3)]))

group('compile — no aspects', () => {
  for (const n of SIZES) {
    const f = plain.get(n)!
    bench(`${n} bindings`, () => compileOnce(f))
  }
})

group('compile — 3 aspects x 2 predicate pointcuts', () => {
  for (const n of SIZES) {
    const f = withAspects.get(n)!
    bench(`${n} bindings`, () => compileOnce(f))
  }
})

group('full boot (init + dispose) — no aspects', () => {
  for (const n of SIZES) {
    const f = plain.get(n)!
    bench(`${n} bindings`, () => bootOnce(f))
  }
})

group('full boot (init + dispose) — 3 aspects x 2 predicate pointcuts', () => {
  for (const n of SIZES) {
    const f = withAspects.get(n)!
    bench(`${n} bindings`, () => bootOnce(f))
  }
})

await run()
