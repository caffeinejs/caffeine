import { describe, expect, it, vi } from 'vitest'

import { relayedClient, relayURL } from './outage.js'

const { createClient, startProxy } = vi.hoisted(() => ({
  createClient: vi.fn(() => ({ on: vi.fn(), connect: vi.fn(), destroy: vi.fn() })),
  startProxy: vi.fn(() => Promise.resolve({ port: 41234, release: vi.fn(), accept: vi.fn(), close: vi.fn() })),
}))

vi.mock('@redis/client', () => ({ createClient }))
vi.mock('../tcp_proxy.js', () => ({ startProxy }))

// The relayed client must reach the same data the specs' direct clients read: a relay that dropped the database
// would have the lock write one database while the assertions read another.
describe('outage relay', () => {
  it('keeps the database, credentials and options of the URL it relays', () => {
    expect(relayURL('redis://user:pass@cache.internal:6390/2?name=specs', 41234)).toBe(
      'redis://user:pass@127.0.0.1:41234/2?name=specs',
    )
  })

  it('verifies TLS against the upstream hostname while connecting to loopback', async () => {
    const relayed = await relayedClient('rediss://cache.internal:6390/2')
    await relayed.close()

    expect(createClient).toHaveBeenCalledWith({
      url: 'rediss://127.0.0.1:41234/2',
      socket: { reconnectStrategy: expect.any(Function), tls: true, servername: 'cache.internal' },
    })
  })

  it('passes an unbracketed IPv6 address and the default port to the upstream socket', async () => {
    const relayed = await relayedClient('rediss://[::1]/2')
    await relayed.close()

    expect(startProxy).toHaveBeenLastCalledWith({ host: '::1', port: 6379 })
    expect(createClient).toHaveBeenLastCalledWith({
      url: 'rediss://127.0.0.1:41234/2',
      socket: { reconnectStrategy: expect.any(Function), tls: true, checkServerIdentity: expect.any(Function) },
    })
  })
})
