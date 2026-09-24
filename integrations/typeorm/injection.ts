import {
  type Binding,
  defineInjection,
  type InjectionMiddleware,
  type InjectionResult,
  type NamedToken,
  registerStage,
} from '@caffeinejs/di'
import { DataSource, type EntityTarget, type ObjectLiteral, type Repository } from 'typeorm'

import { ErrNoDataSource, ErrNoUniqueDataSource } from './errors.js'
import { dataSourceKey } from './keys.js'

const kRepositoryStage: unique symbol = Symbol('@caffeinejs/typeorm:stage.repository')

const repositoryStage: InjectionMiddleware = (ctx, _next, args) => {
  const target = args as EntityTarget<ObjectLiteral>
  const key = ctx.descriptor.key

  if (ctx.bindings.length === 0) {
    if (ctx.descriptor.optional) {
      return () => undefined
    }

    throw new ErrNoDataSource(key, target)
  }

  // A primary binding is unshifted to the front when it registers, so this is the rule the default terminal
  // applies too.
  if (ctx.bindings.length > 1 && !ctx.bindings[0].primary) {
    throw new ErrNoUniqueDataSource(key, target)
  }

  // Built once, while the container compiles, so resolution is one provider read.
  const provider = ctx.container.wrapBinding(ctx.bindings[0] as Binding<DataSource>)

  return () => provider.get().getRepository(target)
}

registerStage(kRepositoryStage, repositoryStage, { terminal: true })

/** The injection helpers `$typeorm` exposes. */
export interface TypeORMInjections {
  /**
   * Injects the TypeORM repository for an entity.
   *
   * @param target - The entity the repository is for: an `EntitySchema`, a class, or a table name.
   * @param dataSource - The instance name given to `typeorm(name, ...)`, or a token the DataSource is bound
   *   to. Defaults to TypeORM's `DataSource`, where an unnamed feature binds it. A string is always read as
   *   an instance name, so a DataSource the application provides itself needs a symbol token.
   *
   * @throws {@link ErrNoDataSource} while the container compiles, when nothing is bound to the key.
   * @throws {@link ErrNoUniqueDataSource} while the container compiles, when several are and none is primary.
   */
  repository<E extends ObjectLiteral>(
    target: EntityTarget<E>,
    dataSource?: string | NamedToken<DataSource>,
  ): InjectionResult<Repository<E>>
}

/**
 * The TypeORM injection helpers, mirroring the `$i` catalog in `@caffeinejs/di`.
 *
 * The result carries the same mark `$i`'s own helpers do, so `$i.optional($typeorm.repository(User))` and
 * `$i.provide($typeorm.repository(User))` both work.
 */
export const $typeorm: TypeORMInjections = {
  repository: (target, dataSource) =>
    defineInjection({
      key: typeof dataSource === 'string' ? dataSourceKey(dataSource) : (dataSource ?? DataSource),
      stages: [{ name: kRepositoryStage, args: target }],
    }),
}
