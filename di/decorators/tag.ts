import { notNil } from '../internal/util/assert/not_nil.js'
import { extendInjectableAttributes, extendMemberInjectableAttributes } from './registrar/index.js'
import { defineClassOrMemberDecorator } from './util/index.js'

/**
 * Attaches a key-value metadata tag to a binding.
 *
 * @param key - Symbol key.
 * @param value - Tag value.
 *
 * @example
 * ```ts
 * const PRIORITY = Symbol('priority')
 *
 * @Tag(PRIORITY, 10)
 * @Injectable()
 * class CriticalService {}
 * ```
 */
export function Tag(key: symbol, value: unknown) {
  notNil(key, `@${Tag.name}(): parameter key is required.`)
  notNil(value, `@${Tag.name}(): parameter value is required.`)

  const tags = new Map([[key, value]])

  return defineClassOrMemberDecorator(
    (target, ctx) => extendInjectableAttributes(ctx.metadata, target, config => config.tags(tags)),
    ctx => extendMemberInjectableAttributes(ctx.metadata, ctx.name!, config => config.tags(tags)),
  )
}
