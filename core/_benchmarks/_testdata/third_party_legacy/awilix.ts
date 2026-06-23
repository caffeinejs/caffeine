// @ts-nocheck

import { createContainer, asClass, InjectionMode, Lifetime } from 'awilix'

class AwilixRep1 {}

class AwilixRep2 {}

class AwilixRep3 {}

class AwilixSvc1 {
  constructor({ awilixRep1, awilixRep2, awilixRep3 }) {
    this.repo1 = awilixRep1
    this.repo2 = awilixRep2
    this.repo3 = awilixRep3
  }
}

class AwilixSvc2 {}

class AwilixSvc3 {}

class AwilixSvc4 {}

class AwilixSvc5 {}

class AwilixSvc6 {}

export class AwilixRoot {
  constructor({ awilixSvc1, awilixSvc2, awilixSvc3, awilixSvc4, awilixSvc5, awilixSvc6 }) {
    this.svc1 = awilixSvc1
    this.svc2 = awilixSvc2
    this.svc3 = awilixSvc3
    this.svc4 = awilixSvc4
    this.svc5 = awilixSvc5
    this.svc6 = awilixSvc6
  }
}

export class AwilixSingletonRoot {
  constructor({ awilixSvc1, awilixSvc2, awilixSvc3, awilixSvc4, awilixSvc5, awilixSvc6 }) {
    this.svc1 = awilixSvc1
    this.svc2 = awilixSvc2
    this.svc3 = awilixSvc3
    this.svc4 = awilixSvc4
    this.svc5 = awilixSvc5
    this.svc6 = awilixSvc6
  }
}

export const awilixContainer = createContainer({ injectionMode: InjectionMode.PROXY })

awilixContainer.register({
  awilixRep1: asClass(AwilixRep1, { lifetime: Lifetime.TRANSIENT }),
  awilixRep2: asClass(AwilixRep2, { lifetime: Lifetime.TRANSIENT }),
  awilixRep3: asClass(AwilixRep3, { lifetime: Lifetime.TRANSIENT }),
  awilixSvc1: asClass(AwilixSvc1, { lifetime: Lifetime.TRANSIENT }),
  awilixSvc2: asClass(AwilixSvc2, { lifetime: Lifetime.TRANSIENT }),
  awilixSvc3: asClass(AwilixSvc3, { lifetime: Lifetime.TRANSIENT }),
  awilixSvc4: asClass(AwilixSvc4, { lifetime: Lifetime.TRANSIENT }),
  awilixSvc5: asClass(AwilixSvc5, { lifetime: Lifetime.TRANSIENT }),
  awilixSvc6: asClass(AwilixSvc6, { lifetime: Lifetime.TRANSIENT }),
  awilixRoot: asClass(AwilixRoot, { lifetime: Lifetime.TRANSIENT }),
  awilixSingletonRoot: asClass(AwilixSingletonRoot, { lifetime: Lifetime.SINGLETON }),
})
