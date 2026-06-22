import { injectable, singleton } from 'tsyringe'
import { container as tsy } from 'tsyringe'

@injectable()
class TsyRep1 {}

@injectable()
class TsyRep2 {}

@injectable()
class TsyRep3 {}

@injectable()
class TsySvc1 {
  constructor(
    readonly repo1: TsyRep1,
    readonly repo2: TsyRep2,
    readonly repo3: TsyRep3,
  ) {}
}

@injectable()
class TsySvc2 {}

@injectable()
class TsySvc3 {}

@injectable()
class TsySvc4 {}

@injectable()
class TsySvc5 {}

@injectable()
class TsySvc6 {}

@injectable()
export class TsyRoot {
  constructor(
    readonly svc1: TsySvc1,
    readonly svc2: TsySvc2,
    readonly svc3: TsySvc3,
    readonly svc4: TsySvc4,
    readonly svc5: TsySvc5,
    readonly svc6: TsySvc6,
  ) {}
}

@singleton()
export class TsySingletonRoot {
  constructor(
    readonly svc1: TsySvc1,
    readonly svc2: TsySvc2,
    readonly svc3: TsySvc3,
    readonly svc4: TsySvc4,
    readonly svc5: TsySvc5,
    readonly svc6: TsySvc6,
  ) {}
}

export { tsy }
