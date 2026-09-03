import { Extends } from '../../../decorators/extends.js'
import { Injectable } from '../../../decorators/injectable.js'
import { $i } from '../../../injection.js'

export abstract class DispatchHandler {}

@Extends(DispatchHandler)
@Injectable()
export class DispatchHandlerA extends DispatchHandler {}

@Extends(DispatchHandler)
@Injectable()
export class DispatchHandlerB extends DispatchHandler {}

@Injectable([$i.allOf($i.defer(() => DispatchHandler))])
export class Dispatcher {
  constructor(readonly handlers: DispatchHandler[]) {}
}
