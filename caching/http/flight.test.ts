import { describe, expect, it } from 'vitest'

import { Flight } from './flight.js'

describe('Flight', () => {
  // A request already over has no response left to serve: it waits on nobody, and is not handed the outcome of a
  // handler run that settles after it gave up.
  it('hands a request that is already over nothing, at once', async () => {
    const flight = new Flight(new Map(), 'k', 60_000)

    const outcome = flight.wait(AbortSignal.abort())
    flight.settle('stored')

    expect(await outcome).toBeUndefined()
  })
})
