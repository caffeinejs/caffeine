import { $aop, Aspect, CaffeineIoC, Injectable, Order, type JoinPoint, type MethodAspect } from '@caffeinejs/di'
import { bench, do_not_optimize, group, run, summary } from 'mitata'

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

// Bounded, so the argument stays a small integer for every case: an unbounded counter shared by the four would
// hand the later ones heap numbers. The result is consumed, or V8 inlines `plain.add` and drops the call.
let n = 0
const next = (): number => (n = (n + 1) & 0xffff)

group('method calls', () => {
  summary(() => {
    bench('plain', () => do_not_optimize(plain.add(next(), 1)))
    bench('aspect: before', () => do_not_optimize(withBefore.add(next(), 1)))
    bench('aspect: around', () => do_not_optimize(withAround.add(next(), 1)))
    bench('aspect: stacked x2', () => do_not_optimize(withStacked.add(next(), 1)))
  })
})

await run({ colors: process.stdout.isTTY === true })
