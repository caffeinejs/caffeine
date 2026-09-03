import { $aop, Aspect, CaffeineIoC, Injectable, Order, type JoinPoint, type MethodAspect } from '@caffeinejs/di'
import { bench, group, run } from 'mitata'

@Injectable()
class Plain {
  add(a: number, b: number): number {
    return a + b
  }
}

@Injectable()
class WithBeforeAspect {
  add(a: number, b: number): number {
    return a + b
  }
}

@Aspect([$aop.forClass(WithBeforeAspect, 'add')])
class BeforeAspect implements MethodAspect<WithBeforeAspect> {
  before(jp: JoinPoint<WithBeforeAspect>): void {
    void jp.args
  }
}
void BeforeAspect

@Injectable()
class WithAroundAspect {
  add(a: number, b: number): number {
    return a + b
  }
}

@Aspect([$aop.forClass(WithAroundAspect, 'add')])
class AroundAspect implements MethodAspect<WithAroundAspect> {
  around(jp: JoinPoint<WithAroundAspect>): unknown {
    return jp.proceed(...jp.args)
  }
}
void AroundAspect

@Injectable()
class WithStackedAspects {
  add(a: number, b: number): number {
    return a + b
  }
}

@Order(1)
@Aspect([$aop.forClass(WithStackedAspects, 'add')])
class StackedAspect1 implements MethodAspect<WithStackedAspects> {
  before(jp: JoinPoint<WithStackedAspects>): void {
    void jp.args
  }
}
void StackedAspect1

@Order(2)
@Aspect([$aop.forClass(WithStackedAspects, 'add')])
class StackedAspect2 implements MethodAspect<WithStackedAspects> {
  before(jp: JoinPoint<WithStackedAspects>): void {
    void jp.args
  }
}
void StackedAspect2

const di = new CaffeineIoC()
di.bind(Plain, t => t.toSelf())
di.bind(WithBeforeAspect, t => t.toSelf())
di.bind(WithAroundAspect, t => t.toSelf())
di.bind(WithStackedAspects, t => t.toSelf())
await di.init()

const plain = di.get(Plain)
const withBefore = di.get(WithBeforeAspect)
const withAround = di.get(WithAroundAspect)
const withStacked = di.get(WithStackedAspects)

let n = 0

group('method calls', () => {
  bench('plain', () => plain.add(n++, n))
  bench('aspect: before', () => withBefore.add(n++, n))
  bench('aspect: around', () => withAround.add(n++, n))
  bench('aspect: stacked x2', () => withStacked.add(n++, n))
})

const { benchmarks } = await run({ colors: process.stdout.isTTY === true })

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
