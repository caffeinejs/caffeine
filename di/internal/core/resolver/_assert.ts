import { ErrMissingInjectionKey } from '../../../errors.js'
import { InjectionResolverFactoryContext } from '../../../injection_resolver.js'
import { solutions } from '../../util/errutil/errutil.js'
import { describeContext } from './_fmt.js'

export function assertKeyIsPresent(ctx: InjectionResolverFactoryContext, extra: string = ''): void {
  if (ctx.key === undefined || ctx.key === null) {
    throw new ErrMissingInjectionKey(`${describeContext(ctx)}: no injection key provided${extra ? `: ${extra}` : ''}`)
  }
}

export function assertInjectionKeyIsPresent(ctx: InjectionResolverFactoryContext, extra: string = ''): void {
  if (!ctx.descriptor.key) {
    throw new ErrMissingInjectionKey(
      `${describeContext(ctx)}: no injection key provided${extra ? `: ${extra}` : ''}` +
        solutions(
          `- Provide an injection key`,
          `- For circular dependencies, use "defer(() => key)" to defer resolution`,
        ),
    )
  }
}
