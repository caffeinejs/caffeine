import { Factory } from '../../../factory.js'
import { ResolutionContext } from '../../../resolution_context.js'
import { Scope } from '../../../scope.js'

export function scopedFactory<T>(scope: Scope, creator: Factory<T>): Factory<T> {
  return (ctx: ResolutionContext): T => scope.provide(ctx, creator)
}
