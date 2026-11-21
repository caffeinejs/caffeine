import { Controller, Post } from '@caffeinejs/http'

import { CacheInvalidate } from './cache_invalidate.js'

// Evicting is what a mutating request does, so the decorator goes on the route that mutates, never on a whole
// controller, whose reads would evict too. `npm run test:typecheck` is the test.

@Controller('/pets')
class Pets {
  @CacheInvalidate({ tags: ['pets'] })
  @Post('/')
  create(): string {
    return 'created'
  }
}
void Pets

// @ts-expect-error a controller is not a route
@CacheInvalidate({ tags: ['pets'] })
@Controller('/all')
class All {}
void All
