import { Container } from '@inferdi/inferdi'

class Rep1 {}

class Rep2 {}

class Rep3 {}

class Svc1 {
  constructor(
    readonly repo1: Rep1,
    readonly repo2: Rep2,
    readonly rep3: Rep3,
  ) {}
}

class Svc2 {}

class Svc3 {}

class Svc4 {}

class Svc5 {}

class Svc6 {}

class Root {
  constructor(
    readonly svc1: Svc1,
    readonly svc2: Svc2,
    readonly svc3: Svc3,
    readonly svc4: Svc4,
    readonly svc5: Svc5,
    readonly svc6: Svc6,
  ) {}
}

class Rep1S {}

class Rep2S {}

class Rep3S {}

class Svc1S {
  constructor(
    readonly repo1: Rep1S,
    readonly repo2: Rep2S,
    readonly rep3: Rep3S,
  ) {}
}

class Svc2S {}

class Svc3S {}

class Svc4S {}

class Svc5S {}

class Svc6S {}

class RootSingleton {
  constructor(
    readonly svc1: Svc1S,
    readonly svc2: Svc2S,
    readonly svc3: Svc3S,
    readonly svc4: Svc4S,
    readonly svc5: Svc5S,
    readonly svc6: Svc6S,
  ) {}
}

function build(fast: boolean) {
  const container = fast ? new Container({ fast: true }) : new Container()
  return container
    .registerClass('rep1', Rep1, [], 'transient')
    .registerClass('rep2', Rep2, [], 'transient')
    .registerClass('rep3', Rep3, [], 'transient')
    .registerClass('svc1', Svc1, ['rep1', 'rep2', 'rep3'], 'transient')
    .registerClass('svc2', Svc2, [], 'transient')
    .registerClass('svc3', Svc3, [], 'transient')
    .registerClass('svc4', Svc4, [], 'transient')
    .registerClass('svc5', Svc5, [], 'transient')
    .registerClass('svc6', Svc6, [], 'transient')
    .registerClass('root', Root, ['svc1', 'svc2', 'svc3', 'svc4', 'svc5', 'svc6'], 'transient')
    .registerClass('rep1s', Rep1S, [])
    .registerClass('rep2s', Rep2S, [])
    .registerClass('rep3s', Rep3S, [])
    .registerClass('svc1s', Svc1S, ['rep1s', 'rep2s', 'rep3s'])
    .registerClass('svc2s', Svc2S, [])
    .registerClass('svc3s', Svc3S, [])
    .registerClass('svc4s', Svc4S, [])
    .registerClass('svc5s', Svc5S, [])
    .registerClass('svc6s', Svc6S, [])
    .registerClass('rootSingleton', RootSingleton, ['svc1s', 'svc2s', 'svc3s', 'svc4s', 'svc5s', 'svc6s'])
}

export const inferdi = build(false)
export const inferdiFast = build(true)

inferdi.get('rootSingleton')
inferdiFast.get('rootSingleton')
