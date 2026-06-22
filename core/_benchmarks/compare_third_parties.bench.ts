// reflect-metadata is necessary for the legacy third party implementations
import 'reflect-metadata'

import { bench, group, run } from 'mitata'
import { Root } from './_testdata/di'
import { di } from './_testdata/di'
import { RootSingleton } from './_testdata/di'
import { Rep1 } from './_testdata/di'
import { Svc1 } from './_testdata/di'
import { Rep3 } from './_testdata/di'
import { Rep2 } from './_testdata/di'
import { Svc2 } from './_testdata/di'
import { Svc3 } from './_testdata/di'
import { Svc4 } from './_testdata/di'
import { Svc5 } from './_testdata/di'
import { Svc6 } from './_testdata/di'
import { inv, InvRootSingleton as InvSingletonRoot } from './_testdata/third_party_legacy/dist/inversify'
import { InvRoot } from './_testdata/third_party_legacy/dist/inversify'
import { tsy, TsySingletonRoot } from './_testdata/third_party_legacy/dist/tsy'
import { TsyRoot } from './_testdata/third_party_legacy/dist/tsy'
import { bootstrap } from './_testdata/third_party_legacy/dist/nest'
import { NestRoot } from './_testdata/third_party_legacy/dist/nest'
import { NestTransientRoot } from './_testdata/third_party_legacy/dist/nest'
import { loopCtx, LoopSingletonRoot } from './_testdata/third_party_legacy/dist/loopback'
import { LoopRoot } from './_testdata/third_party_legacy/dist/loopback'
import { typeContainer, TypeSingletonRoot } from './_testdata/third_party_legacy/dist/typedi'
import { TypeRoot } from './_testdata/third_party_legacy/dist/typedi'
import { awilixContainer } from './_testdata/third_party_legacy/dist/awilix'
import { ReflectiveInjector } from 'injection-js'
import { injResolvedProviders } from './_testdata/third_party_legacy/dist/injection_js'
import { injSingletonInjector } from './_testdata/third_party_legacy/dist/injection_js'
import { InjRoot } from './_testdata/third_party_legacy/dist/injection_js'
import { InjSingletonRoot } from './_testdata/third_party_legacy/dist/injection_js'

const nestApp = await bootstrap()
const transientProvider = di.wrap(Root)
const singletonProvider = di.wrap(RootSingleton)

group('normal', () => {
  bench('raw', () => new Root(new Svc1(new Rep1(), new Rep2(), new Rep3()), new Svc2(), new Svc3(), new Svc4(), new Svc5(), new Svc6()))
  bench('dicaf:transient', () => di.get(Root))
  bench('dicaf:transient:provider', () => transientProvider.get())
  bench('dicaf:singleton', () => di.get(RootSingleton))
  bench('dicaf:singleton:provider', () => singletonProvider.get())
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
  if (ns < 1_000) return `${ns.toFixed(2)} ns`
  if (ns < 1_000_000) return `${(ns / 1_000).toFixed(2)} µs`
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
