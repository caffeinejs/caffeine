import { ErrMissingInjectionKey } from '../../../errors.js'
import { InjectionResolverFactoryContext } from '../../../injection_resolver.js'
import { errMessage } from '../../util/errutil/errutil.gen.js'
import { describeContext } from './_fmt.js'

export function assertKeyIsPresent(ctx: InjectionResolverFactoryContext, extra: string = ''): void {
  if (ctx.key === undefined || ctx.key === null) {
    throw new ErrMissingInjectionKey(
      errMessage(`${describeContext(ctx)}: no injection key provided${extra ? `: ${extra}` : ''}`)
        .reference('@caffeinejs/di', ErrMissingInjectionKey)
        .build(),
    )
  }
}

export function assertInjectionKeyIsPresent(ctx: InjectionResolverFactoryContext, extra: string = ''): void {
  if (!ctx.descriptor.key) {
    throw new ErrMissingInjectionKey(
      errMessage(`${describeContext(ctx)}: no injection key provided${extra ? `: ${extra}` : ''}`)
        .solutions(`Provide an injection key`, `For circular dependencies, use "defer(() => key)" to defer resolution`)
        .reference('@caffeinejs/di', ErrMissingInjectionKey)
        .build(),
    )
  }
}
