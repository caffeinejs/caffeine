import { Injectable } from '../../../decorators/injectable.js'
import { Extends } from '../../../decorators/extends.js'
import { $i } from '../../../injection.js'

export abstract class SoleHandler {}

@Extends(SoleHandler)
@Injectable([$i.allOf($i.defer(() => SoleHandler))])
export class SoleHandlerA extends SoleHandler {
  constructor(readonly peers: SoleHandler[]) { super() }
}
