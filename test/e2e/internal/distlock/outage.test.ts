import { describe, expect, it } from 'vitest'

import { relayURL, upstreamOf } from './outage.js'

// The relayed client must reach the same data the specs' direct clients read: a relay that dropped the database
// would have the lock write one database while the assertions read another.
describe('outage relay', () => {
  it('keeps the database, credentials and options of the URL it relays', () => {
    expect(relayURL('redis://user:pass@cache.internal:6390/2?name=specs', 41234)).toBe(
      'redis://user:pass@127.0.0.1:41234/2?name=specs',
    )
  })

  it('reaches the Redis port when the URL names none', () => {
    expect(upstreamOf('redis://cache.internal/2')).toEqual({ host: 'cache.internal', port: 6379 })
  })
})
