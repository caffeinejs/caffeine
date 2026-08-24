import { describe, it, expect, vi, afterEach } from 'vitest'
import { ErrHealthConfiguration } from './errors.js'
import { defaultHealthOptions, emitHealthWarnings, validateHealthOptions } from './options.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('defaultHealthOptions', () => {
  it('stays off with no drain delay outside an orchestrator', () => {
    const options = defaultHealthOptions({})

    expect(options.enabled).toBe(false)
    expect(options.drainDelayMs).toBe(0)
    expect(options.paths).toEqual({ live: '/livez', ready: '/readyz', startup: '/startupz' })
  })

  it('turns itself on with a drain delay inside a pod', () => {
    const options = defaultHealthOptions({ KUBERNETES_SERVICE_HOST: '10.0.0.1' })

    expect(options.enabled).toBe(true)
    expect(options.drainDelayMs).toBe(5_000)
  })

  it('reads the termination grace period from the downward API when the pod publishes it', () => {
    expect(defaultHealthOptions({ TERMINATION_GRACE_PERIOD_SECONDS: '60' }).terminationGracePeriodMs).toBe(60_000)
    expect(defaultHealthOptions({}).terminationGracePeriodMs).toBe(30_000)
    expect(defaultHealthOptions({ TERMINATION_GRACE_PERIOD_SECONDS: 'nonsense' }).terminationGracePeriodMs).toBe(30_000)
  })

  it('installs no signal handlers under a test runner', () => {
    expect(defaultHealthOptions({ NODE_ENV: 'test' }).signals).toBe(false)
    expect(defaultHealthOptions({}).signals).toEqual(['SIGTERM', 'SIGINT'])
  })
})

describe('validateHealthOptions', () => {
  const budget = (drainDelayMs: number, shutdownTimeoutMs: number, terminationGracePeriodMs: number) =>
    ({ ...defaultHealthOptions({}), drainDelayMs, shutdownTimeoutMs, terminationGracePeriodMs })

  it('accepts a budget that fits the grace period', () => {
    const options = budget(5_000, 20_000, 30_000)

    const validated = validateHealthOptions(options, {})

    expect(validated.warnings).toEqual([])
    expect(validated.options.shutdownTimeoutMs).toBe(20_000)
  })

  it('clamps a shutdown timeout that would outlive the grace period', () => {
    const options = budget(5_000, 60_000, 30_000)

    const validated = validateHealthOptions(options, {})

    expect(validated.options.shutdownTimeoutMs).toBe(23_000)
    expect(validated.warnings[0]).toContain('exceeds the termination grace period')
  })

  it('throws when the drain delay alone cannot fit the grace period', () => {
    const options = budget(30_000, 1_000, 20_000)

    expect(() => validateHealthOptions(options, {})).toThrow(ErrHealthConfiguration)
  })

  it('warns about a zero drain delay inside a pod', () => {
    const options = { ...defaultHealthOptions({}), enabled: true, drainDelayMs: 0 }

    const validated = validateHealthOptions(options, { KUBERNETES_SERVICE_HOST: '10.0.0.1' })

    expect(validated.warnings[0]).toContain('drain delay is 0')
  })

  it('stays quiet about a zero drain delay outside a pod', () => {
    const options = { ...defaultHealthOptions({}), enabled: true, drainDelayMs: 0 }

    expect(validateHealthOptions(options, {}).warnings).toEqual([])
  })
})

describe('emitHealthWarnings', () => {
  it('emits each warning as a capturable node warning', () => {
    const emit = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})

    emitHealthWarnings(['first', 'second'])

    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit).toHaveBeenCalledWith('first', 'CaffeineHealthWarning')
  })
})
