import { describe, it, expect } from 'vitest'
import { ApplicationAvailability } from './availability.js'

describe('ApplicationAvailability', () => {
  it('starts live but refusing traffic', () => {
    const availability = new ApplicationAvailability()

    expect(availability.live).toBe('correct')
    expect(availability.ready).toBe('refusing')
    expect(availability.readinessReason).toBe('starting')
    expect(availability.started).toBe(false)
    expect(availability.draining).toBe(false)
  })

  it('accepts traffic once running', () => {
    const availability = new ApplicationAvailability().markStarted().acceptTraffic()

    expect(availability.started).toBe(true)
    expect(availability.ready).toBe('accepting')
    expect(availability.readinessReason).toBeUndefined()
  })

  it('refuses traffic and keeps liveness correct while draining', () => {
    const availability = new ApplicationAvailability().markStarted().acceptTraffic().beginDrain()

    expect(availability.draining).toBe(true)
    expect(availability.ready).toBe('refusing')
    expect(availability.readinessReason).toBe('shutdown')
    // The whole point: a draining process must not be restarted, it must be left alone to finish.
    expect(availability.live).toBe('correct')
  })

  it('never returns to accepting once draining', () => {
    const availability = new ApplicationAvailability().markStarted().acceptTraffic().beginDrain()

    availability.acceptTraffic()

    expect(availability.ready).toBe('refusing')
    expect(availability.readinessReason).toBe('shutdown')
  })

  it('refuses traffic without draining', () => {
    const availability = new ApplicationAvailability().markStarted().acceptTraffic()

    availability.refuseTraffic('reconnecting')

    expect(availability.ready).toBe('refusing')
    expect(availability.readinessReason).toBe('reconnecting')
    expect(availability.draining).toBe(false)

    availability.acceptTraffic()

    expect(availability.ready).toBe('accepting')
  })

  it('tracks the liveness state independently of readiness', () => {
    const availability = new ApplicationAvailability().markStarted().acceptTraffic()

    availability.refuseTraffic('dependency down')
    expect(availability.live).toBe('correct')

    availability.markBroken('deadlocked')
    expect(availability.live).toBe('broken')
    expect(availability.livenessReason).toBe('deadlocked')

    availability.markCorrect()
    expect(availability.live).toBe('correct')
    expect(availability.livenessReason).toBeUndefined()
    expect(availability.ready).toBe('refusing')
  })
})
