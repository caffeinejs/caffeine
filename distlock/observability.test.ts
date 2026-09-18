import { subscribe, unsubscribe } from 'node:diagnostics_channel'

import { CaffeineIoC } from '@caffeinejs/di'
import { createApplication } from '@caffeinejs/std'
import { afterEach, describe, expect, it } from 'vitest'

import type { Backend } from './backend.js'
import { FaultyBackend } from './backend.testkit.js'
import { MemoryLockBackend } from './backend/memory/index.js'
import type { DistLockBuilder } from './builder.js'
import type { DistLock } from './distlock.js'
import { ErrLockNotAcquired } from './errors.js'
import { kDistLock } from './keys.js'
import { RecordingLogger } from './log.testkit.js'
import {
  DIST_LOCK_CHANNELS,
  type AcquireContext,
  type ExtendContext,
  type LostMessage,
  type OnceContext,
  type ReleaseContext,
  type WithLockContext,
} from './observability/channels.js'
import { distlock } from './plugin.js'

interface Published {
  readonly channel: keyof typeof DIST_LOCK_CHANNELS
  /** The tracing sub-event, or `message` for a plain channel. */
  readonly sub: string
  readonly payload: { service: DistLock } & Record<string, unknown>
}

const opened: Array<() => Promise<unknown>> = []
const stops: Array<() => void> = []

afterEach(async () => {
  for (const stop of stops.splice(0)) {
    stop()
  }

  for (const close of opened.splice(0)) {
    await close()
  }
})

async function newApp(
  backend: Backend = new MemoryLockBackend(),
  configure?: (d: DistLockBuilder) => void,
): Promise<{ lock: DistLock; log: RecordingLogger }> {
  const log = new RecordingLogger()
  const app = createApplication({ container: new CaffeineIoC({ decorators: false }), logger: log }).with(
    distlock(d => {
      d.backend(backend)
      configure?.(d)
    }),
  )

  await app.ready()
  opened.push(() => app.close())

  return { lock: app.container.get(kDistLock), log }
}

/** Everything published on every channel, in order, kept to one lock service. */
function record(service: DistLock): Published[] {
  const published: Published[] = []

  for (const channel of Object.keys(DIST_LOCK_CHANNELS) as Array<keyof typeof DIST_LOCK_CHANNELS>) {
    const name = DIST_LOCK_CHANNELS[channel]
    const subs = channel === 'contended' || channel === 'lost' ? [''] : ['start', 'end', 'error', 'asyncEnd']

    for (const sub of subs) {
      const source = sub === '' ? name : `tracing:${name}:${sub}`
      const onMessage = (message: unknown): void => {
        const payload = message as Published['payload']
        if (payload.service === service) {
          published.push({ channel, sub: sub === '' ? 'message' : sub, payload })
        }
      }

      subscribe(source, onMessage)
      stops.push(() => unsubscribe(source, onMessage))
    }
  }

  return published
}

function ended<T>(published: Published[], channel: Published['channel']): T[] {
  return published.filter(p => p.channel === channel && p.sub === 'asyncEnd').map(p => p.payload as unknown as T)
}

function messages<T>(published: Published[], channel: 'contended' | 'lost'): T[] {
  return published.filter(p => p.channel === channel).map(p => p.payload as unknown as T)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time')
    }
    await sleep(5)
  }
}

describe('distlock diagnostics channels', () => {
  // A metric or a span is built from the one sub-event every call reaches. Two, or none, and every count and
  // every duration computed from the channel is wrong.
  it('ends every acquisition in exactly one asyncEnd carrying its outcome', async () => {
    const backend = new FaultyBackend()
    const { lock } = await newApp(backend)
    const published = record(lock)

    await lock.tryAcquire('a')
    await lock.tryAcquire('a')
    await lock.acquire('a', { wait: 20, retryDelay: 5 }).catch(() => undefined)
    await lock.acquire('a', { wait: '10s', signal: AbortSignal.abort() }).catch(() => undefined)
    backend.failAcquire = true
    await lock.tryAcquire('b').catch(() => undefined)
    backend.failAcquire = false
    await lock.once('a', () => 'never')

    expect(ended<AcquireContext>(published, 'acquire').map(ctx => [ctx.mode, ctx.outcome])).toEqual([
      ['try', 'acquired'],
      ['try', 'held'],
      ['wait', 'timeout'],
      ['wait', 'aborted'],
      ['try', 'error'],
      ['once', 'held'],
    ])
  })

  it('publishes error before asyncEnd when the call rejects', async () => {
    const { lock } = await newApp()
    await lock.acquire('a', { ttl: '1m' })
    const published = record(lock)

    await expect(lock.acquire('a', { wait: 10, retryDelay: 5 })).rejects.toBeInstanceOf(ErrLockNotAcquired)

    expect(published.filter(p => p.channel === 'acquire').map(p => p.sub)).toEqual([
      'start',
      'end',
      'error',
      'asyncEnd',
    ])
  })

  // `attempts` is what an acquisition histogram records; it has to agree with what the contention counter saw.
  it('counts one contended message per failed attempt, and one more attempt for the one that took the key', async () => {
    const { lock } = await newApp()
    const held = await lock.acquire('a', { ttl: '1m' })
    const published = record(lock)

    setTimeout(() => void held.release(), 30)
    await lock.acquire('a', { wait: '2s', retryDelay: 5 })

    const [ctx] = ended<AcquireContext>(published, 'acquire')
    const contended = messages(published, 'contended')

    expect(contended.length).toBeGreaterThan(0)
    expect(ctx!.attempts).toBe(contended.length + 1)
    expect(ctx!.outcome).toBe('acquired')
  })

  // An abort is the caller changing its mind. Counting it as a backend failure would page someone for nothing.
  it('tells an aborted acquisition apart from a backend failure', async () => {
    const backend = new FaultyBackend()
    const { lock, log } = await newApp(backend)
    await lock.acquire('a', { ttl: '1m' })
    const published = record(lock)

    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('gone')), 20)
    await lock.acquire('a', { wait: '10s', retryDelay: 5, signal: controller.signal }).catch(() => undefined)

    expect(ended<AcquireContext>(published, 'acquire')[0]!.outcome).toBe('aborted')
    expect(log.at('warn')).toEqual([])

    backend.failAcquire = true
    await lock.acquire('b').catch(() => undefined)

    expect(ended<AcquireContext>(published, 'acquire')[1]!.outcome).toBe('error')
    expect(log.at('warn').map(r => r.msg)).toEqual(['lock backend failed'])
    expect(log.at('warn')[0]!.fields.err).toBeInstanceOf(Error)
  })

  // The failure a lock exists to prevent: work still running after the key was free for someone else to take.
  it('flags a critical section that outran its lease, and warns about it once', async () => {
    const { lock, log } = await newApp()
    const published = record(lock)

    await lock.withLock('a', () => sleep(40), { ttl: 20 })

    expect(ended<WithLockContext>(published, 'withLock')[0]!.lapsed).toBe(true)
    expect(ended<ReleaseContext>(published, 'release')[0]!.lapsed).toBe(true)
    expect(log.at('warn').map(r => r.msg)).toEqual(['lock released after its lease lapsed'])
  })

  it('does not flag a critical section that finished inside its lease', async () => {
    const { lock, log } = await newApp()
    const published = record(lock)

    await lock.withLock('a', () => 'done', { ttl: '1m' })

    const [release] = ended<ReleaseContext>(published, 'release')
    expect(release!.lapsed).toBe(false)
    expect(release!.heldMs).toBeGreaterThanOrEqual(0)
    expect(log.at('warn')).toEqual([])
  })

  // One lease, many events: without a shared ID nothing downstream can tell which acquisition a renewal or a
  // loss belongs to.
  it('ties renewals and the loss that ends them to the lease that started them', async () => {
    const backend = new FaultyBackend()
    const { lock, log } = await newApp(backend)
    const published = record(lock)

    const held = await lock.acquire('a', { ttl: 60, renew: true })
    await until(() => ended(published, 'extend').length > 0)

    backend.stolen = true
    await until(() => messages(published, 'lost').length > 0)

    const extends_ = ended<ExtendContext>(published, 'extend')
    const [lost] = messages<LostMessage>(published, 'lost')

    expect(extends_[0]).toMatchObject({ leaseID: held.leaseID, renewal: true, outcome: 'extended' })
    expect(extends_.at(-1)).toMatchObject({ leaseID: held.leaseID, renewal: true, outcome: 'lost' })
    expect(lost).toMatchObject({ leaseID: held.leaseID, reason: 'taken', renewal: true })
    expect(held.lost).toBe(true)
    expect(log.at('warn').map(r => r.msg)).toEqual(['lock lease lost'])
  })

  // A renewal is a background timer: a backend failure there must end the lease quietly for the holder, while
  // still reaching whoever watches the channels — once as the failure, once as the loss it caused.
  it('reports a renewal the backend failed as an error and as a lost lease, with one warning', async () => {
    const backend = new FaultyBackend()
    const { lock, log } = await newApp(backend)
    const published = record(lock)

    backend.failExtend = true
    const held = await lock.acquire('a', { ttl: 60, renew: true })
    await until(() => messages(published, 'lost').length > 0)

    // The failure first, then the loss it caused: a listener on both hears them in the order they happened.
    const order = published
      .filter(p => p.channel === 'extend' || p.channel === 'lost')
      .map(p => `${p.channel}:${p.sub}`)
    expect(order).toEqual(['extend:start', 'extend:end', 'extend:error', 'extend:asyncEnd', 'lost:message'])
    expect(ended<ExtendContext>(published, 'extend')[0]!.outcome).toBe('error')
    expect(messages<LostMessage>(published, 'lost')[0]).toMatchObject({ leaseID: held.leaseID, reason: 'error' })
    expect(held.lost).toBe(true)
    expect(log.at('warn').map(r => r.msg)).toEqual(['lock backend failed'])
  })

  // `once` leaves the key standing on success, so a release event there would describe something that did not
  // happen — and a hold-duration metric would record a window as a critical section.
  it('reports each once outcome, and no release after an executed once', async () => {
    const { lock } = await newApp()
    const published = record(lock)

    await lock.once('job', () => 'ran', { ttl: '1m' })
    await lock.once('job', () => 'skipped')
    await lock.once('other', () => Promise.reject(new Error('boom'))).catch(() => undefined)

    expect(ended<OnceContext>(published, 'once').map(ctx => ctx.outcome)).toEqual(['executed', 'skipped', 'failed'])

    const [executed] = ended<OnceContext>(published, 'once')
    const released = ended<ReleaseContext>(published, 'release').map(ctx => ctx.leaseID)
    expect(released).not.toContain(executed!.leaseID)
    expect(released).toHaveLength(1)
  })

  it('reports an explicit extend the backend refused as a lost lease', async () => {
    const backend = new FaultyBackend()
    const { lock } = await newApp(backend)
    const published = record(lock)

    const held = await lock.acquire('a', { ttl: '1m' })
    backend.stolen = true

    expect(await held.extend()).toBe(false)
    expect(ended<ExtendContext>(published, 'extend')[0]).toMatchObject({ renewal: false, outcome: 'lost' })
    expect(messages<LostMessage>(published, 'lost')[0]).toMatchObject({ reason: 'taken', renewal: false })
  })

  // A backend that could not be reached has said nothing about the key. A renewal has nobody to ask, so it
  // gives the lease up; an explicit extend has a caller, who decides — the lease is theirs until they do.
  it('lets an explicit extend the backend failed through without giving the lease up', async () => {
    const backend = new FaultyBackend()
    const { lock, log } = await newApp(backend)
    const published = record(lock)

    const held = await lock.acquire('a', { ttl: '1m' })
    backend.failExtend = true

    await expect(held.extend()).rejects.toThrow('backend down')

    expect(held.lost).toBe(false)
    expect(await lock.tryAcquire('a')).toBeUndefined()
    expect(ended<ExtendContext>(published, 'extend')[0]).toMatchObject({ renewal: false, outcome: 'error' })
    expect(messages(published, 'lost')).toEqual([])
    expect(log.at('warn').map(r => r.msg)).toEqual(['lock backend failed'])
  })

  // `once` leaves the key standing, so a window that lapsed under its action is the one place nothing else
  // reports the overrun: no release happens to notice it.
  it('flags a once action that outran its window, and warns about it once', async () => {
    const { lock, log } = await newApp()
    const published = record(lock)

    await lock.once('job', () => sleep(40), { ttl: 20 })

    expect(ended<OnceContext>(published, 'once')[0]).toMatchObject({ outcome: 'executed', lapsed: true })
    expect(ended(published, 'release')).toEqual([])
    expect(messages(published, 'lost')).toEqual([])
    expect(log.at('warn').map(r => r.msg)).toEqual(['lock once outlived its lease'])
  })

  it('flags a failed once action that outran its window when the key is left standing', async () => {
    const { lock, log } = await newApp()
    const published = record(lock)

    await lock
      .once('job', () => sleep(40).then(() => Promise.reject(new Error('boom'))), { ttl: 20, releaseOnError: false })
      .catch(() => undefined)

    expect(ended<OnceContext>(published, 'once')[0]).toMatchObject({ outcome: 'failed', lapsed: true })
    expect(ended(published, 'release')).toEqual([])
    expect(log.at('warn').map(r => r.msg)).toEqual(['lock once outlived its lease'])
  })
})

describe('distlock logging', () => {
  it('writes to the application logger, as a child named distlock, when .logger() is never called', async () => {
    const { lock, log } = await newApp()

    await lock.withLock('a', () => 'done')
    await lock.once('job', () => 'ran')

    const records = log.records.filter(r => r.msg.startsWith('lock '))
    expect(records.map(r => r.msg)).toEqual(['lock acquired', 'lock released', 'lock acquired', 'lock once settled'])
    expect(records.every(r => r.bindings.name === 'distlock')).toBe(true)
  })

  it('writes nothing when .logger(false) is given', async () => {
    const { lock, log } = await newApp(undefined, d => d.logger(false))

    await lock.withLock('a', () => 'done')
    await lock.acquire('a', { ttl: '1m' })
    await lock.acquire('a', { wait: 10, retryDelay: 5 }).catch(() => undefined)

    expect(log.records.filter(r => r.msg.startsWith('lock '))).toEqual([])
  })

  it('writes to the logger given to .logger()', async () => {
    const own = new RecordingLogger()
    const { lock, log } = await newApp(undefined, d => d.logger(own))

    await lock.withLock('a', () => 'done')

    expect(own.records.map(r => r.msg)).toEqual(['lock acquired', 'lock released'])
    expect(log.records.filter(r => r.msg.startsWith('lock '))).toEqual([])
  })

  it('warns once when an acquisition times out, and keeps attempts at trace', async () => {
    const { lock, log } = await newApp()
    await lock.acquire('a', { ttl: '1m' })

    await lock.acquire('a', { wait: 20, retryDelay: 5 }).catch(() => undefined)

    expect(log.at('warn').map(r => r.msg)).toEqual(['lock acquisition timed out'])
    expect(log.at('trace').every(r => r.msg === 'lock contended')).toBe(true)
    expect(log.at('trace').length).toBeGreaterThan(0)
  })
})
