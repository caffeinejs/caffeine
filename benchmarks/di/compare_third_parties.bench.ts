// reflect-metadata is necessary for the legacy third party implementations
import 'reflect-metadata'
import { ReflectiveInjector } from 'injection-js'
import { bench, do_not_optimize, group, run, summary } from 'mitata'

import { Root, di, RootSingleton, Rep1, Svc1, Rep3, Rep2, Svc2, Svc3, Svc4, Svc5, Svc6 } from './testdata/di.js'
import { inferdi, inferdiFast } from './testdata/inferdi.js'
import { awilixContainer } from './testdata/third_party_legacy/dist/awilix.js'
import {
  injResolvedProviders,
  injSingletonInjector,
  InjRoot,
  InjSingletonRoot,
} from './testdata/third_party_legacy/dist/injection_js.js'
import { inv, InvRootSingleton as InvSingletonRoot, InvRoot } from './testdata/third_party_legacy/dist/inversify.js'
import { loopCtx, LoopSingletonRoot, LoopRoot } from './testdata/third_party_legacy/dist/loopback.js'
import { bootstrap, NestRoot, NestTransientRoot } from './testdata/third_party_legacy/dist/nest.js'
import { tsy, TsySingletonRoot, TsyRoot } from './testdata/third_party_legacy/dist/tsy.js'
import { typeContainer, TypeSingletonRoot, TypeRoot } from './testdata/third_party_legacy/dist/typedi.js'

const nestApp = await bootstrap()
const transientProvider = di.wrap(Root)
const singletonProvider = di.wrap(RootSingleton)

group('normal', () => {
  summary(() => {
    // Consumed, or escape analysis removes the whole allocation and the baseline reads as free.
    bench('raw', () =>
      do_not_optimize(
        new Root(
          new Svc1(new Rep1(), new Rep2(), new Rep3()),
          new Svc2(),
          new Svc3(),
          new Svc4(),
          new Svc5(),
          new Svc6(),
        ),
      ))
    bench('caffeine-ioc:transient', () => di.get(Root))
    bench('caffeine-ioc:transient:provider', () => transientProvider.get())
    bench('caffeine-ioc:singleton', () => di.get(RootSingleton))
    bench('caffeine-ioc:singleton:provider', () => singletonProvider.get())
    bench('inferdi:transient', () => inferdi.get('root'))
    bench('inferdi:singleton', () => inferdi.get('rootSingleton'))
    bench('inferdi:fast:transient', () => inferdiFast.get('root'))
    bench('inferdi:fast:singleton', () => inferdiFast.get('rootSingleton'))
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
})

await run()
