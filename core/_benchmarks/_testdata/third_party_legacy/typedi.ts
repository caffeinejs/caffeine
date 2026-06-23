// @ts-nocheck

import { Service, Container } from 'typedi'

@Service({ transient: true })
class TypeRep1 {}

@Service({ transient: true })
class TypeRep2 {}

@Service({ transient: true })
class TypeRep3 {}

@Service({ transient: true })
class TypeSvc1 {
  constructor(
    readonly repo1: TypeRep1,
    readonly repo2: TypeRep2,
    readonly repo3: TypeRep3,
  ) {}
}

@Service({ transient: true })
class TypeSvc2 {}

@Service({ transient: true })
class TypeSvc3 {}

@Service({ transient: true })
class TypeSvc4 {}

@Service({ transient: true })
class TypeSvc5 {}

@Service({ transient: true })
class TypeSvc6 {}

@Service({ transient: true })
export class TypeRoot {
  constructor(
    readonly svc1: TypeSvc1,
    readonly svc2: TypeSvc2,
    readonly svc3: TypeSvc3,
    readonly svc4: TypeSvc4,
    readonly svc5: TypeSvc5,
    readonly svc6: TypeSvc6,
  ) {}
}

@Service()
export class TypeSingletonRoot {
  constructor(
    readonly svc1: TypeSvc1,
    readonly svc2: TypeSvc2,
    readonly svc3: TypeSvc3,
    readonly svc4: TypeSvc4,
    readonly svc5: TypeSvc5,
    readonly svc6: TypeSvc6,
  ) {}
}

export { Container as typeContainer }
