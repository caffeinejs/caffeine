import { Injectable } from '@caffeinejs/di'
import { kAppMessage } from './config.js'

@Injectable([kAppMessage])
export class AppService {
  constructor(readonly message: string) {}
}
