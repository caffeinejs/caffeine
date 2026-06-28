import { Tag } from '@caffeinejs/core'
import { kConfig } from './keys/keys.js'

export function Config(config: Record<string | symbol, unknown>, override = false) {
  return (fn: Function, context: ClassMemberDecoratorContext): void => {
    Tag(kConfig, { config, override })(fn, context)
  }
}
