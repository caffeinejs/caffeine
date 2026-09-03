import { InjectionResolverFactoryContext } from '../../../injection_resolver.js'
import { keyStr } from '../../../key.js'

export function describeContext(ctx: InjectionResolverFactoryContext): string {
  let message = ''
  if (ctx.key !== undefined && ctx.key !== null) {
    message += `Error resolving "${keyStr(ctx.key)}": `
  }

  switch (ctx.kind) {
    case 'constructor':
      message += 'Parameter'
      break
    case 'property':
      message += `Property "${String(ctx.member)}"`
      break
    case 'method':
      message += `Method "${String(ctx.member)}"`
      break
  }

  if (ctx.index !== -1) {
    message += ` at index [${ctx.index}]`
  }
  if (ctx.descriptor.key) {
    message += ` with injection key "${keyStr(ctx.descriptor.key)}"`
  }

  message += ` cannot be resolved`

  return message
}
