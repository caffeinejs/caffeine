// @ts-nocheck

import { injectable } from 'inversify'
import { Container } from 'inversify'

@injectable()
class InvRep1 {}

@injectable()
class InvRep2 {}

@injectable()
class InvRep3 {}

@injectable()
class InvSvc1 {
  constructor(
    readonly repo1: InvRep1,
    readonly repo2: InvRep2,
    readonly repo3: InvRep3,
  ) {}
}

@injectable()
class InvSvc2 {}

@injectable()
class InvSvc3 {}

@injectable()
class InvSvc4 {}

@injectable()
class InvSvc5 {}

@injectable()
class InvSvc6 {}

@injectable()
export class InvRoot {
  constructor(
    readonly svc1: InvSvc1,
    readonly svc2: InvSvc2,
    readonly svc3: InvSvc3,
    readonly svc4: InvSvc4,
    readonly svc5: InvSvc5,
    readonly svc6: InvSvc6,
  ) {}
}

@injectable()
export class InvRootSingleton {
  constructor(
    readonly svc1: InvSvc1,
    readonly svc2: InvSvc2,
    readonly svc3: InvSvc3,
    readonly svc4: InvSvc4,
    readonly svc5: InvSvc5,
    readonly svc6: InvSvc6,
  ) {}
}

const inv = new Container()

inv.bind(InvRep1).toSelf()
inv.bind(InvRep2).toSelf()
inv.bind(InvRep3).toSelf()
inv.bind(InvSvc1).toSelf()
inv.bind(InvSvc2).toSelf()
inv.bind(InvSvc3).toSelf()
inv.bind(InvSvc4).toSelf()
inv.bind(InvSvc5).toSelf()
inv.bind(InvSvc6).toSelf()
inv.bind(InvRoot).toSelf()
inv.bind(InvRootSingleton).toSelf().inSingletonScope()

export { inv }
