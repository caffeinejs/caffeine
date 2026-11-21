import { ErrConfiguration } from '@caffeinejs/http'
import { describe, expect, it } from 'vitest'

import { CacheInvalidate } from './cache_invalidate.js'

describe('@CacheInvalidate', () => {
  // On a controller every route would evict, its reads included: the type refuses a class, and so does a caller the
  // type does not reach.
  it('refuses a class', () => {
    const decorate = CacheInvalidate({ tags: ['pets'] }) as unknown as (
      target: Function,
      context: ClassDecoratorContext,
    ) => void

    let failure: unknown
    try {
      decorate(class Pets {}, { kind: 'class', name: 'Pets', metadata: {} } as unknown as ClassDecoratorContext)
    } catch (err) {
      failure = err
    }

    expect(failure).toBeInstanceOf(ErrConfiguration)
    expect((failure as Error).message.split('\n')[0]).toBe(
      'Cannot apply @CacheInvalidate to the class "Pets": it decorates a method',
    )
  })
})
