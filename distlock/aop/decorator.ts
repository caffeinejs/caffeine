import type { Annotation } from '@caffeinejs/di'

import { ErrInvalidLockKey } from '../errors.js'

// A guarded call may be skipped, so the method must return a promise whose type includes `undefined`:
// `Promise<void>`, or `Promise<T | undefined>`.
type AsyncMethod<This, A extends unknown[], R> = (this: This, ...args: A) => Promise<R>

// The check sits on the context, so `R` is inferred from the method alone.
type SkippableContext<This, A extends unknown[], R> = ClassMethodDecoratorContext<This, AsyncMethod<This, A, R>> &
  (undefined extends R ? unknown : { readonly 'the method must resolve to a type that includes undefined': never })

/** A decorator for a method whose call may be skipped. */
export type SkippableMethodDecorator = <This, A extends unknown[], R>(
  target: AsyncMethod<This, A, R>,
  context: SkippableContext<This, A, R>,
) => void

/** What every lock decorator stores: the key, and the options of the call it makes. */
export interface LockAnnotation<O> {
  readonly key: string
  readonly options: O
}

// The decorator a caller writes, over the annotation the aspect reads.
export type LockDecorator<O> = ((key: string, options?: O) => SkippableMethodDecorator) &
  Annotation<LockAnnotation<O>, 'method'>

export function annotated<O>(key: unknown, options: O | undefined): LockAnnotation<O> {
  if (typeof key !== 'string' || key === '') {
    throw new ErrInvalidLockKey(key)
  }

  return { key, options: options ?? ({} as O) }
}
