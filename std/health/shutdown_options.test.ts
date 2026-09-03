import { describe, it, expect } from 'vitest'

import {
  defaultShutdownOptions,
  isKubernetes,
  isTestEnvironment,
  resolveShutdownOptions,
  toMillis,
} from './shutdown_options.js'
import { noopSignalDispatcher } from './signals.js'

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
    expect(options.signals).toEqual(['SIGTERM', 'SIGINT'])
  })

  it('waits for the routing table inside a pod', () => {
    expect(defaultShutdownOptions({ KUBERNETES_SERVICE_HOST: '10.0.0.1' }).drainDelayMs).toBe(5_000)
  })

  it('installs no handlers under a test runner', () => {
    expect(defaultShutdownOptions({ NODE_ENV: 'test' }).signals).toBe(false)
  })
})

describe('resolveShutdownOptions', () => {
  it('falls back to the defaults when given nothing', () => {
    expect(resolveShutdownOptions(undefined, {})).toMatchObject({ drainDelayMs: 0, shutdownTimeoutMs: 25_000 })
  })

  it('normalizes durations and keeps the supplied dispatcher', () => {
    const resolved = resolveShutdownOptions(
      { drainDelay: '2s', shutdownTimeout: 1_500, signals: ['SIGTERM'], dispatcher: noopSignalDispatcher },
      {},
    )

    expect(resolved).toEqual({
      drainDelayMs: 2_000,
      shutdownTimeoutMs: 1_500,
      signals: ['SIGTERM'],
      dispatcher: noopSignalDispatcher,
    })
  })

  it('treats an explicit false as a choice, not an omission', () => {
    expect(resolveShutdownOptions({ signals: false }, {}).signals).toBe(false)
  })
})
