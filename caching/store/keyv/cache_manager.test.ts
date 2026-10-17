import { createCache, type Cache } from 'cache-manager'
import { expectTypeOf, it } from 'vitest'

import { describeHTTPCacheStoreContract } from '../../http/store.testkit.js'
import { KeyvHTTPCacheStore, type KeyvHTTPCacheClient } from './index.js'

describeHTTPCacheStoreContract(
  'KeyvHTTPCacheStore on a cache-manager cache',
  () => new KeyvHTTPCacheStore(createCache()),
)

// A cache-manager cache is handed to the store as it comes. If this stops holding, wrap it at the call site
// rather than widening the store's seam.
it('takes a cache-manager cache without an adapter', () => {
  expectTypeOf<Cache>().toExtend<KeyvHTTPCacheClient>()
})
