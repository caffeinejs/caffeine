import { Injectable, ReflectiveInjector } from 'injection-js'
import type { ResolvedReflectiveProvider } from 'injection-js'

@Injectable()
class InjRep1 {}

@Injectable()
class InjRep2 {}

@Injectable()
class InjRep3 {}

@Injectable()
class InjSvc1 {
  constructor(
    readonly rep1: InjRep1,
    readonly rep2: InjRep2,
    readonly rep3: InjRep3,
  ) {}
}

@Injectable()
class InjSvc2 {}

@Injectable()
class InjSvc3 {}

@Injectable()
class InjSvc4 {}

@Injectable()
class InjSvc5 {}

@Injectable()
class InjSvc6 {}

@Injectable()
export class InjRoot {
  constructor(
    readonly svc1: InjSvc1,
    readonly svc2: InjSvc2,
    readonly svc3: InjSvc3,
    readonly svc4: InjSvc4,
    readonly svc5: InjSvc5,
    readonly svc6: InjSvc6,
  ) {}
}

@Injectable()
export class InjSingletonRoot {
  constructor(
    readonly svc1: InjSvc1,
    readonly svc2: InjSvc2,
    readonly svc3: InjSvc3,
    readonly svc4: InjSvc4,
    readonly svc5: InjSvc5,
    readonly svc6: InjSvc6,
  ) {}
}

export const injResolvedProviders: ResolvedReflectiveProvider[] = ReflectiveInjector.resolve([
  InjRep1,
  InjRep2,
  InjRep3,
  InjSvc1,
  InjSvc2,
  InjSvc3,
  InjSvc4,
  InjSvc5,
  InjSvc6,
  InjRoot,
  InjSingletonRoot,
])

export const injSingletonInjector: ReflectiveInjector = ReflectiveInjector.fromResolvedProviders(injResolvedProviders)
