// reflect-metadata is necessary for the legacy third party implementations
import 'reflect-metadata'

import { bench, group, run } from 'mitata'
import { Root, di, RootSingleton } from './_testdata/di'
import { inv, InvRootSingleton as InvSingletonRoot, InvRoot } from './_testdata/third_party_legacy/dist/inversify'
import { tsy, TsySingletonRoot, TsyRoot } from './_testdata/third_party_legacy/dist/tsy'
import { bootstrap, NestRoot } from './_testdata/third_party_legacy/dist/nest'
import { loopCtx, LoopSingletonRoot, LoopRoot } from './_testdata/third_party_legacy/dist/loopback'
import { typeContainer, TypeRoot, TypeSingletonRoot } from './_testdata/third_party_legacy/dist/typedi'

const nestApp = await bootstrap()

group('transient', () => {
  bench('di', () => di.get(Root))
  bench('inversify', () => inv.get(InvRoot))
  bench('tsyringe', () => tsy.resolve(TsyRoot))
  bench('loopback', () => loopCtx.getSync(LoopRoot.name))
  bench('typedi', () => typeContainer.get(TypeRoot))
})

group('singleton', () => {
  bench('di', () => di.get(RootSingleton))
  bench('inversify', () => inv.get(InvSingletonRoot))
  bench('tsyringe', () => tsy.resolve(TsySingletonRoot))
  bench('nestjs', () => nestApp.get(NestRoot))
  bench('loopback', () => loopCtx.getSync(LoopSingletonRoot.name))
  bench('typedi', () => typeContainer.get(TypeSingletonRoot))
})

await run()
