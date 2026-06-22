import { notNil } from '../internal/util/assert/not_nil.js'
import { Identifier } from '../key.js'
import { extendInjectableAttributes, extendMemberInjectableAttributes } from './registrar/index.js'
import { defineClassOrMemberDecorator } from './util/index.js'

/**
 * Assigns one or more named identifiers to a binding, enabling resolution by name.
 * Multiple bindings can be registered with the same name. This allows multiple resolutions for a single name,
 * but note that when a single instance is requested, and no disambiguation strategy is provided, an error will be thrown.
 * Check the documentation for more details.
 *
 * @param name - First identifier (required).
 * @param names - Additional identifiers.
 *
 * @example
 * ```ts
 * interface Repository { }
 *
 * @Injectable()
 * @Named('repository', 'in-memory)
 * class InMemoryRepository implements Repository { }
 *
 * @Named('repository', 'mysql')
 * @Injectable()
 * class MySQLRepository implements Repository { }
 *
 * @Injectable(['mysql'])
 * class MainDataSource {
 *   constructor(readonly repository: Repository) {}
 * }
 * ```
 */
export function Named(name: Identifier, ...names: Identifier[]) {
  notNil(name, `@${Named.name} name parameter is required.`)

  const nms = [name, ...names]

  return defineClassOrMemberDecorator(
    (target, ctx) => extendInjectableAttributes(ctx.metadata, target, config => config.names(nms)),
    ctx => extendMemberInjectableAttributes(ctx.metadata, ctx.name!, config => config.names(nms)),
  )
}
