import { Injectable } from '../../../decorators/injectable.js'
import { kAppMessage } from './config.js'

@Injectable([kAppMessage])
export class AppService {
  constructor(readonly message: string) {}
}
