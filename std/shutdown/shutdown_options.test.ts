import { describe, it, expect, vi, afterEach } from 'vitest'

import { ErrShutdownConfiguration } from './errors.js'
import {
  defaultShutdownOptions,
  emitShutdownWarnings,
  isKubernetes,
  isTestEnvironment,
  mergeShutdownConfig,
  toMillis,
  validateShutdownOptions,
} from './shutdown_options.js'
import { noopSignalDispatcher } from './signals.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('toMillis', () => {
  // parseDuration returns seconds for a string and passes a number through, so the conversion has to be explicit.
  it('treats a bare number as milliseconds', () => {
    expect(toMillis(5_000)).toBe(5_000)
  })

  it('converts a duration string to milliseconds', () => {
    expect(toMillis('5s')).toBe(5_000)
    expect(toMillis('500ms')).toBe(500)
    expect(toMillis('2m')).toBe(120_000)
    expect(toMillis('1m30s')).toBe(90_000)
  })
})

describe('isKubernetes', () => {
  it('detects the kubelet-injected service host', () => {
    expect(isKubernetes({ KUBERNETES_SERVICE_HOST: '10.0.0.1' })).toBe(true)
    expect(isKubernetes({})).toBe(false)
    expect(isKubernetes({ KUBERNETES_SERVICE_HOST: '' })).toBe(false)
  })
})

describe('isTestEnvironment', () => {
  it('detects a test runner', () => {
    expect(isTestEnvironment({ NODE_ENV: 'test' })).toBe(true)
    expect(isTestEnvironment({ VITEST: 'true' })).toBe(true)
    expect(isTestEnvironment({ NODE_ENV: 'production' })).toBe(false)
  })
})

describe('defaultShutdownOptions', () => {
  it('waits for nothing outside an orchestrator', () => {
    const options = defaultShutdownOptions({})

    expect(options.drainDelayMs).toBe(0)
    expect(options.shutdownTimeoutMs).toBe(25_000)
    expect(options.terminationGracePeriodMs).toBe(30_000)
    expect(options.signals).toEqual(['SIGTERM', 'SIGINT'])
  })

  it('waits for the routing table inside a pod', () => {
    expect(defaultShutdownOptions({ KUBERNETES_SERVICE_HOST: '10.0.0.1' }).drainDelayMs).toBe(5_000)
  })

  it('keeps a static grace period regardless of the environment', () => {
    expect(defaultShutdownOptions({ TERMINATION_GRACE_PERIOD_SECONDS: '60' }).terminationGracePeriodMs).toBe(30_000)
  })

  it('installs no handlers under a test runner', () => {
    expect(defaultShutdownOptions({ NODE_ENV: 'test' }).signals).toBe(false)
  })
})

describe('mergeShutdownConfig', () => {
  it('falls back to the defaults for what the slice does not set', () => {
    expect(mergeShutdownConfig({})).toMatchObject({ shutdownTimeoutMs: 25_000, terminationGracePeriodMs: 30_000 })
  })

  it('normalizes durations and keeps the supplied dispatcher', () => {
    const merged = mergeShutdownConfig(
      { drainDelay: '2s', shutdownTimeout: 1_500, signals: ['SIGTERM'] },
      { dispatcher: noopSignalDispatcher },
    )

    expect(merged).toMatchObject({
      drainDelayMs: 2_000,
      shutdownTimeoutMs: 1_500,
      signals: ['SIGTERM'],
      dispatcher: noopSignalDispatcher,
    })
  })

  it('treats an explicit false as a choice, not an omission', () => {
    expect(mergeShutdownConfig({ signals: false }).signals).toBe(false)
  })

  it('lets an explicit zero drain delay override the environment default', () => {
    // A pod default of 5_000 must still be disableable in code.
    const withPodDefault = mergeShutdownConfig({ drainDelay: 0 })
    expect(withPodDefault.drainDelayMs).toBe(0)
  })
})

describe('validateShutdownOptions', () => {
  const budget = (drainDelayMs: number, shutdownTimeoutMs: number, terminationGracePeriodMs: number) => ({
    ...defaultShutdownOptions({}),
    drainDelayMs,
    shutdownTimeoutMs,
    terminationGracePeriodMs,
  })

  it('accepts a budget that fits the grace period', () => {
    const validated = validateShutdownOptions(budget(5_000, 20_000, 30_000), {})

    expect(validated.warnings).toEqual([])
    expect(validated.options.shutdownTimeoutMs).toBe(20_000)
  })

  it('clamps a shutdown timeout that would outlive the grace period', () => {
    const validated = validateShutdownOptions(budget(5_000, 60_000, 30_000), {})

    expect(validated.options.shutdownTimeoutMs).toBe(23_000)
    expect(validated.warnings[0]).toContain('exceeds the termination grace period')
  })

  it('throws when the drain delay alone cannot fit the grace period', () => {
    expect(() => validateShutdownOptions(budget(30_000, 1_000, 20_000), {})).toThrow(ErrShutdownConfiguration)
  })

  it('warns about a zero drain delay inside a pod', () => {
    const validated = validateShutdownOptions(budget(0, 20_000, 30_000), { KUBERNETES_SERVICE_HOST: '10.0.0.1' })

    expect(validated.warnings[0]).toContain('drain delay is 0')
  })

  it('stays quiet about a zero drain delay outside a pod', () => {
    expect(validateShutdownOptions(budget(0, 20_000, 30_000), {}).warnings).toEqual([])
  })
})

describe('emitShutdownWarnings', () => {
  it('emits each warning as a capturable node warning', () => {
    const emit = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})

    emitShutdownWarnings(['first', 'second'])

    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit).toHaveBeenCalledWith('first', 'CaffeineShutdownWarning')
  })
})
