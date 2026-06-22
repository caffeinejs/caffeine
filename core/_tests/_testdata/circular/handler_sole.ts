import { Injectable } from '../../../decorators/injectable.js'
import { Extends } from '../../../decorators/extends.js'
import { allOf, defer } from '../../../injection.js'

export abstract class SoleHandler {}

@Extends(SoleHandler)
@Injectable([allOf(defer(() => SoleHandler))])
export class SoleHandlerA extends SoleHandler {
  constructor(readonly peers: SoleHandler[]) { super() }
}
