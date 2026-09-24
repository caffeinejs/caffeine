import { createCache, type Cache } from 'cache-manager'
import { expectTypeOf, it } from 'vitest'

import { describeHTTPCacheStoreContract } from '../../http/store.testkit.js'
import { KeyValueHTTPCacheStore, type KeyValueHTTPCacheClient } from './keyv.js'

describeHTTPCacheStoreContract(
  'KeyValueHTTPCacheStore on a cache-manager cache',
  () => new KeyValueHTTPCacheStore(createCache()),
)

// A cache-manager cache is handed to the store as it comes. If this stops holding, wrap it at the call site
// rather than widening the store's seam.
it('takes a cache-manager cache without an adapter', () => {
  expectTypeOf<Cache>().toExtend<KeyValueHTTPCacheClient>()
})
