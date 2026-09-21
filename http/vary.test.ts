import { describe, it, expect } from 'vitest'

import { appendVary, type VaryReply } from './vary.js'

function newReply(vary?: string | string[]): VaryReply & { headers: Record<string, string | string[]> } {
  const headers: Record<string, string | string[]> = vary === undefined ? {} : { vary }

  return {
    headers,
    getHeader: name => headers[name],
    header: (name, value) => {
      headers[name] = value
    },
  }
}

describe('appendVary', () => {
  it('sets the header when the reply has none', () => {
    const reply = newReply()

    appendVary(reply, ['Accept-Language'])

    expect(reply.headers.vary).toBe('Accept-Language')
  })

  // A plugin that ran earlier, CORS for one, already told downstream caches what the response varies on.
  // Dropping its field would let a shared cache serve one origin the response meant for another.
  it('keeps the fields another plugin already set', () => {
    const reply = newReply('Origin')

    appendVary(reply, ['Accept-Language'])

    expect(reply.headers.vary).toBe('Origin, Accept-Language')
  })

  // A reply header may be set from a list, and is then read back as one. Treating it as "no header" would
  // replace what the other plugin said instead of adding to it.
  it('keeps the fields of a header that was set from a list', () => {
    const reply = newReply(['Origin', 'Accept, accept-encoding'])

    appendVary(reply, ['Accept-Language', 'ACCEPT'])

    expect(reply.headers.vary).toBe('Origin, Accept, accept-encoding, Accept-Language')
  })

  it('does not repeat a field that differs only in case, and keeps the first spelling', () => {
    const reply = newReply('accept-version')

    appendVary(reply, ['Accept-Version', 'Origin'])

    expect(reply.headers.vary).toBe('accept-version, Origin')
  })

  it('leaves a Vary: * already on the reply alone', () => {
    const reply = newReply('*')

    appendVary(reply, ['Origin'])

    expect(reply.headers.vary).toBe('*')
  })

  it('collapses to * when one of the names is *', () => {
    const reply = newReply('Origin')

    appendVary(reply, ['*'])

    expect(reply.headers.vary).toBe('*')
  })
})
