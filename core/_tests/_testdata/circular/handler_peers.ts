import { Injectable } from '../../../decorators/injectable.js'
import { Extends } from '../../../decorators/extends.js'
import { $i } from '../../../injection.js'

export abstract class Handler {}

@Extends(Handler)
@Injectable([$i.allOf($i.defer(() => Handler))])
export class HandlerA extends Handler {
  constructor(readonly peers: Handler[]) { super() }
}

@Extends(Handler)
@Injectable()
export class HandlerB extends Handler {}

@Extends(Handler)
@Injectable()
export class HandlerC extends Handler {}
