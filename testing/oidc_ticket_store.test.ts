import { describe, it, expect } from 'vitest'
import type { RemoteAuthenticationTicket } from '@caffeinejs/http'
import { TestOidcTicketStore } from './oidc_ticket_store.js'

/**
 * The store expires tickets against a monotonic clock, which fake timers do not reach.
 * Driving time by hand is also more honest: the assertions say exactly how far the clock
 * moved, with no dependency on which globals the timer library happens to patch.
 */
function manualClock() {
  let ms = 0
  return { now: () => ms, advance: (by: number) => void (ms += by) }
}

function ticket(subject: string): RemoteAuthenticationTicket {
  return {
    subject,
    session: {
      claims: [{ type: 'sub', value: subject, issuer: 'https://example.com' }],
      scheme: 'Google',
    },
  }
}

describe('TestOidcTicketStore', () => {
  it('round-trips a stored ticket', async () => {
    const store = new TestOidcTicketStore()
    await store.store('k1', ticket('u1'), 3600)

    expect(await store.retrieve('k1')).toEqual(ticket('u1'))
  })

  it('returns undefined for an unknown key', async () => {
    const store = new TestOidcTicketStore()
    expect(await store.retrieve('nope')).toBeUndefined()
  })

  it('returns undefined after remove', async () => {
    const store = new TestOidcTicketStore()
    await store.store('k1', ticket('u1'), 3600)
    await store.remove('k1')

    expect(await store.retrieve('k1')).toBeUndefined()
  })

  it('removing an unknown key is a no-op', async () => {
    const store = new TestOidcTicketStore()
    await expect(store.remove('nope')).resolves.toBeUndefined()
  })

  it('clear() forgets everything', async () => {
    const store = new TestOidcTicketStore()
    await store.store('a', ticket('u1'), 3600)
    await store.store('b', ticket('u2'), 3600)

    store.clear()

    expect(store.size).toBe(0)
    expect(await store.retrieve('a')).toBeUndefined()
  })
})

describe('TestOidcTicketStore expiry', () => {
  it('stops returning a ticket once its ttl has passed', async () => {
    const clock = manualClock()
    const store = new TestOidcTicketStore({ clock })
    await store.store('k1', ticket('u1'), 60)

    clock.advance(59_000)
    expect(await store.retrieve('k1')).toBeDefined()

    clock.advance(2_000)
    expect(await store.retrieve('k1')).toBeUndefined()
  })

  it('drops expired tickets from the count', async () => {
    const clock = manualClock()
    const store = new TestOidcTicketStore({ clock })
    await store.store('a', ticket('u1'), 60)
    await store.store('b', ticket('u2'), 600)

    clock.advance(61_000)

    expect(store.size).toBe(1)
  })

  it('does not accumulate expired tickets', async () => {
    const clock = manualClock()
    const store = new TestOidcTicketStore({ clock })

    for (let i = 0; i < 50; i++) {
      await store.store(`k${i}`, ticket(`u${i}`), 60)
      clock.advance(61_000)
    }

    expect(store.size).toBe(0)
  })
})

describe('TestOidcTicketStore.removeBySubject()', () => {
  // The reason a ticket store exists at all: revoking every session a user holds, which a
  // self-contained session cookie can never do.
  it('revokes every session belonging to the subject', async () => {
    const store = new TestOidcTicketStore()
    await store.store('a', ticket('u1'), 3600)
    await store.store('b', ticket('u1'), 3600)
    await store.store('c', ticket('u1'), 3600)

    await store.removeBySubject('u1')

    expect(await store.retrieve('a')).toBeUndefined()
    expect(await store.retrieve('b')).toBeUndefined()
    expect(await store.retrieve('c')).toBeUndefined()
  })

  it('leaves other subjects untouched', async () => {
    const store = new TestOidcTicketStore()
    await store.store('a', ticket('u1'), 3600)
    await store.store('b', ticket('u2'), 3600)

    await store.removeBySubject('u1')

    expect(await store.retrieve('a')).toBeUndefined()
    expect(await store.retrieve('b')).toEqual(ticket('u2'))
  })

  it('is a no-op for an unknown subject', async () => {
    const store = new TestOidcTicketStore()
    await store.store('a', ticket('u1'), 3600)

    await expect(store.removeBySubject('nobody')).resolves.toBeUndefined()
    expect(await store.retrieve('a')).toBeDefined()
  })
})
