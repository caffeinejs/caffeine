import type { FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'

import { protocolOf } from './protocol.js'

const requestWith = (protocol: unknown) => ({ protocol }) as unknown as FastifyRequest

describe('protocolOf', () => {
  // A proxy may write the scheme in any case; every reader downstream compares with `https`.
  it('reads the scheme lower-cased, however a trusted proxy wrote it', () => {
    expect(protocolOf(requestWith('HTTPS'))).toBe('https')
    expect(protocolOf(requestWith('http'))).toBe('http')
  })

  // Fastify answers nothing for a request with no socket: an unknown scheme, which no reader takes for HTTPS.
  it('answers an empty scheme when Fastify has none', () => {
    expect(protocolOf(requestWith(undefined))).toBe('')
  })
})
