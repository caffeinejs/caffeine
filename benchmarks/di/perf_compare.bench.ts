// reflect-metadata is necessary for the legacy third party implementations
import 'reflect-metadata'
import { bench, group, run } from 'mitata'

import { Root, di, RootSingleton } from './testdata/di.js'
import { inferdi, inferdiFast } from './testdata/inferdi.js'
import { inv, InvRootSingleton as InvSingletonRoot, InvRoot } from './testdata/third_party_legacy/dist/inversify.js'
import { loopCtx, LoopSingletonRoot, LoopRoot } from './testdata/third_party_legacy/dist/loopback.js'
import { bootstrap, NestRoot } from './testdata/third_party_legacy/dist/nest.js'
import { tsy, TsySingletonRoot, TsyRoot } from './testdata/third_party_legacy/dist/tsy.js'
import { typeContainer, TypeRoot, TypeSingletonRoot } from './testdata/third_party_legacy/dist/typedi.js'

const nestApp = await bootstrap()

group('transient', () => {
  bench('di', () => di.get(Root))
  bench('inferdi', () => inferdi.get('root'))
  bench('inferdi:fast', () => inferdiFast.get('root'))
  bench('inversify', () => inv.get(InvRoot))
  bench('tsyringe', () => tsy.resolve(TsyRoot))
  bench('loopback', () => loopCtx.getSync(LoopRoot.name))
  bench('typedi', () => typeContainer.get(TypeRoot))
})

group('singleton', () => {
  bench('di', () => di.get(RootSingleton))
  bench('inferdi', () => inferdi.get('rootSingleton'))
  bench('inferdi:fast', () => inferdiFast.get('rootSingleton'))
  bench('inversify', () => inv.get(InvSingletonRoot))
  bench('tsyringe', () => tsy.resolve(TsySingletonRoot))
  bench('nestjs', () => nestApp.get(NestRoot))
  bench('loopback', () => loopCtx.getSync(LoopSingletonRoot.name))
  bench('typedi', () => typeContainer.get(TypeSingletonRoot))
})

await run()
