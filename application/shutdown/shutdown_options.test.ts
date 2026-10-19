import { describe, it, expect } from 'vitest'

import { ErrShutdownConfiguration } from './errors.js'
import {
  defaultShutdownOptions,
  isKubernetes,
  isTestEnvironment,
  mergeShutdownConfig,
  validateShutdownOptions,
} from './shutdown_options.js'
import { noopSignalDispatcher } from './signals.js'

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
    expect(options.shutdownTimeoutMs).toBe(28_000)
    expect(options.terminationGracePeriodMs).toBe(30_000)
    expect(options.signals).toEqual(['SIGTERM', 'SIGINT'])
  })

  it('waits for the routing table inside a pod, and hands the teardown what the wait left', () => {
    const options = defaultShutdownOptions({ KUBERNETES_SERVICE_HOST: '10.0.0.1' })

    expect(options.drainDelayMs).toBe(5_000)
    expect(options.shutdownTimeoutMs).toBe(23_000)
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
    expect(mergeShutdownConfig({})).toMatchObject({ shutdownTimeoutMs: 28_000, terminationGracePeriodMs: 30_000 })
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

  // A 0 written in code is a decision about an application nothing routes to. Warning about it anyway told every
  // internal Watt application and headless worker it was dropping requests it never receives.
  it('takes a zero drain delay set in code as meant, and warns about one from the configuration', () => {
    const inPod = { KUBERNETES_SERVICE_HOST: '10.0.0.1' }

    expect(validateShutdownOptions(budget(0, 20_000, 30_000), inPod, { drainDelayInCode: true }).warnings).toEqual([])
    expect(
      validateShutdownOptions(budget(0, 20_000, 30_000), inPod, { drainDelayInCode: false }).warnings[0],
    ).toContain('from the configuration')
  })
})

describe('the shipped defaults', () => {
  // The regression this guards: the shutdown timeout was a constant that did not fit the pod-default drain
  // delay, so an application that configured nothing was warned at boot that its own budget was too large.
  it.each([
    ['outside an orchestrator', {}],
    ['inside a pod', { KUBERNETES_SERVICE_HOST: '10.0.0.1' }],
  ])('fit the grace period with no configuration, %s', (_where, env) => {
    const defaults = defaultShutdownOptions(env)
    const validated = validateShutdownOptions(defaults, env)

    expect(validated.warnings).toEqual([])
    expect(validated.options.shutdownTimeoutMs).toBe(defaults.shutdownTimeoutMs)
  })

  // The drain delay is the one shutdown setting the documentation names, and what both examples set.
  // Configuring it must not produce a warning about a teardown budget nobody touched.
  it('fit the grace period when only the drain delay is configured', () => {
    const merged = mergeShutdownConfig({ drainDelay: '5s' })

    expect(merged.shutdownTimeoutMs).toBe(23_000)
    expect(validateShutdownOptions(merged, {}).warnings).toEqual([])
  })

  // Mirroring a shorter terminationGracePeriodSeconds has to move the derived budget, not overrun it. The drain
  // delay is spelled out because `mergeShutdownConfig` reads the real environment for its defaults.
  it('follow a narrowed grace period', () => {
    const merged = mergeShutdownConfig({ drainDelay: 0, terminationGracePeriod: '10s' })

    expect(merged.shutdownTimeoutMs).toBe(8_000)
    expect(validateShutdownOptions(merged, {}).warnings).toEqual([])
  })

  // The derived timeout is floored at 0, so a budget check alone would read a drain delay that has eaten the
  // whole grace period as fitting inside it.
  it('still fail fast when the drain delay alone cannot fit', () => {
    const merged = mergeShutdownConfig({ drainDelay: '30s', terminationGracePeriod: '20s' })

    expect(merged.shutdownTimeoutMs).toBe(0)
    expect(() => validateShutdownOptions(merged, {})).toThrow(ErrShutdownConfiguration)
  })
})
