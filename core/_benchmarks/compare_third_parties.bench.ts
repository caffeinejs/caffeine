// reflect-metadata is necessary for the legacy third party implementations
import 'reflect-metadata'

import { bench, group, run } from 'mitata'
import { ReflectiveInjector } from 'injection-js'
import { Root, di, RootSingleton, Rep1, Svc1, Rep3, Rep2, Svc2, Svc3, Svc4, Svc5, Svc6 } from './_testdata/di'
import { inv, InvRootSingleton as InvSingletonRoot, InvRoot } from './_testdata/third_party_legacy/dist/inversify'
import { tsy, TsySingletonRoot, TsyRoot } from './_testdata/third_party_legacy/dist/tsy'
import { bootstrap, NestRoot, NestTransientRoot } from './_testdata/third_party_legacy/dist/nest'
import { loopCtx, LoopSingletonRoot, LoopRoot } from './_testdata/third_party_legacy/dist/loopback'
import { typeContainer, TypeSingletonRoot, TypeRoot } from './_testdata/third_party_legacy/dist/typedi'
import { awilixContainer } from './_testdata/third_party_legacy/dist/awilix'
import { injResolvedProviders, injSingletonInjector, InjRoot, InjSingletonRoot } from './_testdata/third_party_legacy/dist/injection_js'

const nestApp = await bootstrap()
const transientProvider = di.wrap(Root)
const singletonProvider = di.wrap(RootSingleton)

group('normal', () => {
  bench('raw', () => new Root(new Svc1(new Rep1(), new Rep2(), new Rep3()), new Svc2(), new Svc3(), new Svc4(), new Svc5(), new Svc6()))
  bench('caffeine-ioc:transient', () => di.get(Root))
  bench('caffeine-ioc:transient:provider', () => transientProvider.get())
  bench('caffeine-ioc:singleton', () => di.get(RootSingleton))
  bench('caffeine-ioc:singleton:provider', () => singletonProvider.get())
  bench('inversify:transient', () => inv.get(InvRoot))
  bench('inversify:singleton', () => inv.get(InvSingletonRoot))
  bench('tsyringe:transient', () => tsy.resolve(TsyRoot))
  bench('tsyringe:singleton', () => tsy.resolve(TsySingletonRoot))
  bench('nestjs:transient', async () => await nestApp.resolve(NestTransientRoot))
  bench('nestjs:singleton', () => nestApp.get(NestRoot))
  bench('loopback:transient', () => loopCtx.getSync(LoopRoot.name))
  bench('loopback:singleton', () => loopCtx.getSync(LoopSingletonRoot.name))
  bench('typedi:transient', () => typeContainer.get(TypeRoot))
  bench('typedi:singleton', () => typeContainer.get(TypeSingletonRoot))
  bench('awilix:transient', () => awilixContainer.resolve('awilixRoot'))
  bench('awilix:singleton', () => awilixContainer.resolve('awilixSingletonRoot'))
  bench('awilix:singleton:cradle', () => awilixContainer.cradle['awilixSingletonRoot'])
  bench('injection-js:transient', () => ReflectiveInjector.fromResolvedProviders(injResolvedProviders).get(InjRoot))
  bench('injection-js:singleton', () => injSingletonInjector.get(InjSingletonRoot))
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
