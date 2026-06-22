import { Injectable, Scope } from '@nestjs/common'
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'

@Injectable()
class NestRep1 {}

@Injectable()
class NestRep2 {}

@Injectable()
class NestRep3 {}

@Injectable()
class NestSvc1 {
  constructor(
    readonly repo1: NestRep1,
    readonly repo2: NestRep2,
    readonly repo3: NestRep3,
  ) {}
}

@Injectable()
class NestSvc2 {}

@Injectable()
class NestSvc3 {}

@Injectable()
class NestSvc4 {}

@Injectable()
class NestSvc5 {}

@Injectable()
class NestSvc6 {}

@Injectable()
export class NestRoot {
  constructor(
    readonly svc1: NestSvc1,
    readonly svc2: NestSvc2,
    readonly svc3: NestSvc3,
    readonly svc4: NestSvc4,
    readonly svc5: NestSvc5,
    readonly svc6: NestSvc6,
  ) {}
}

@Injectable({ scope: Scope.TRANSIENT })
export class NestTransientRoot {
  constructor(
    readonly svc1: NestSvc1,
    readonly svc2: NestSvc2,
    readonly svc3: NestSvc3,
    readonly svc4: NestSvc4,
    readonly svc5: NestSvc5,
    readonly svc6: NestSvc6,
  ) {}
}

@Module({
  providers: [
    NestRep1,
    NestRep2,
    NestRep3,
    NestSvc1,
    NestSvc2,
    NestSvc3,
    NestSvc4,
    NestSvc5,
    NestSvc6,
    NestRoot,
    NestTransientRoot,
  ],
})
export class App {}

export async function bootstrap() {
  return await NestFactory.createApplicationContext(App, { logger: false })
}
