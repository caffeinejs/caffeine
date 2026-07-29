import { CaffeineIoC } from '../../container.js'
import { Injectable } from '../../decorators/injectable.js'
import { Lifetime } from '../../decorators/lifetime.js'
import { Scopes } from '../../scope.js'

@Injectable()
@Lifetime(Scopes.TRANSIENT)
export class Rep1 {}

@Injectable()
@Lifetime(Scopes.TRANSIENT)
export class Rep2 {}

@Injectable()
@Lifetime(Scopes.TRANSIENT)
export class Rep3 {}

@Injectable([Rep1, Rep2, Rep3])
@Lifetime(Scopes.TRANSIENT)
export class Svc1 {
  constructor(
    readonly repo1: Rep1,
    readonly repo2: Rep2,
    readonly rep3: Rep3,
  ) {}
}

@Injectable()
@Lifetime(Scopes.TRANSIENT)
export class Svc2 {}

@Injectable()
@Lifetime(Scopes.TRANSIENT)
export class Svc3 {}

@Injectable()
@Lifetime(Scopes.TRANSIENT)
export class Svc4 {}

@Injectable()
@Lifetime(Scopes.TRANSIENT)
export class Svc5 {}

@Injectable()
@Lifetime(Scopes.TRANSIENT)
export class Svc6 {}

@Injectable([Svc1, Svc2, Svc3, Svc4, Svc5, Svc6])
@Lifetime(Scopes.TRANSIENT)
export class Root {
  constructor(
    readonly svc1: Svc1,
    readonly svc2: Svc2,
    readonly svc3: Svc3,
    readonly svc4: Svc4,
    readonly svc5: Svc5,
    readonly svc6: Svc6,
  ) {}
}

// Singleton graph — isolated from the transient graph above

@Injectable()
export class Rep1S {}

@Injectable()
export class Rep2S {}

@Injectable()
export class Rep3S {}

@Injectable([Rep1S, Rep2S, Rep3S])
export class Svc1S {
  constructor(
    readonly repo1: Rep1S,
    readonly repo2: Rep2S,
    readonly rep3: Rep3S,
  ) {}
}

@Injectable()
export class Svc2S {}

@Injectable()
export class Svc3S {}

@Injectable()
export class Svc4S {}

@Injectable()
export class Svc5S {}

@Injectable()
export class Svc6S {}

@Injectable([Svc1S, Svc2S, Svc3S, Svc4S, Svc5S, Svc6S])
export class RootSingleton {
  constructor(
    readonly svc1: Svc1S,
    readonly svc2: Svc2S,
    readonly svc3: Svc3S,
    readonly svc4: Svc4S,
    readonly svc5: Svc5S,
    readonly svc6: Svc6S,
  ) {}
}

const di = new CaffeineIoC()
await di.init()

export { di }
