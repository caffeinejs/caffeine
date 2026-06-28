import { FastifyCorsOptions } from '@fastify/cors'
import { Tag } from '@caffeinejs/core'
import { kCORS } from './keys/keys.js'

export function CORS(options: FastifyCorsOptions | boolean) {
  return (fn: Function, context: ClassMemberDecoratorContext): void => {
    Tag(kCORS, options)(fn, context)
  }
}
