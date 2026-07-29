import { Scope } from '../../../scope.js'
import { ResolutionContext } from '../../../resolution_context.js'
import { Factory } from '../../../factory.js'

export function scopedFactory<T>(scope: Scope, creator: Factory<T>): Factory<T> {
  return (ctx: ResolutionContext): T => scope.provide(ctx, creator)
}
