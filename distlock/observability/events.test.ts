import { tracingChannel } from 'node:diagnostics_channel'
import { once } from 'node:events'

import { CaffeineIoC, Scopes, type OnBootstrap } from '@caffeinejs/di'
import { createApplication } from '@caffeinejs/std'
import { afterEach, describe, expect, it } from 'vitest'

import { MemoryLockBackend } from '../backend/memory/index.js'
import type { DistLockBuilder } from '../builder.js'
import type { DistLock } from '../distlock.js'
import { kDistLock } from '../keys.js'
import { RecordingLogger } from '../log.testkit.js'
import { distlock } from '../plugin.js'
import { DIST_LOCK_CHANNELS, type AcquireContext } from './channels.js'

const opened: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const close of opened.splice(0)) {
    await close()
  }
})

async function newApp(
  configure?: (d: DistLockBuilder) => void,
  bind?: (container: CaffeineIoC) => void,
): Promise<{ lock: DistLock; log: RecordingLogger; close: () => Promise<void> }> {
  const log = new RecordingLogger()
  const container = new CaffeineIoC({ decorators: false })
  bind?.(container)

  const app = createApplication({ container, logger: log }).with(
    distlock(d => {
      d.backend(new MemoryLockBackend())
      configure?.(d)
    }),
  )

  await app.ready()
  opened.push(() => app.close())

  return { lock: app.container.get(kDistLock), log, close: () => app.close() }
}

// Whether anything at all listens for acquisitions ending: what decides if the core builds a context.
function acquireObserved(): boolean {
  return tracingChannel(DIST_LOCK_CHANNELS.acquire).hasSubscribers
}

describe('DistLock.events', () => {
  // Channels are process-wide; the facade is the per-service view. Leaking another service's events into it
  // would attribute one application's locks to another.
  it('emits only what its own lock service did', async () => {
    const first = await newApp()
    const second = await newApp()
    const seen: string[] = []

    first.lock.events.on('acquire', ctx => seen.push(`first:${ctx.key}`))
    second.lock.events.on('acquire', ctx => seen.push(`second:${ctx.key}`))

    await first.lock.tryAcquire('a')
    await second.lock.tryAcquire('b')

    expect(seen).toEqual(['first:a', 'second:b'])
  })

  it('hands every listener the service it came from and the settled outcome', async () => {
    const { lock } = await newApp()
    const seen: AcquireContext[] = []
    lock.events.on('acquire', ctx => seen.push(ctx))

    const held = await lock.acquire('a')

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ service: lock, key: 'a', outcome: 'acquired', leaseID: held.leaseID })
  })

  // A listener reacting to a lost or lapsed lease has to be able to act before the holder carries on.
  it('reaches the listener before the caller resumes', async () => {
    const { lock } = await newApp()
    const order: string[] = []
    lock.events.on('acquire', () => order.push('event'))

    await lock.tryAcquire('a')
    order.push('resumed')

    expect(order).toEqual(['event', 'resumed'])
  })

  it('works with the node:events helpers', async () => {
    const { lock } = await newApp()
    const held = await lock.acquire('a')

    const released = once(lock.events, 'release')
    await held.release()

    const [ctx] = await released
    expect(ctx).toMatchObject({ key: 'a', leaseID: held.leaseID, lapsed: false })
  })
})

describe('DistLock.events subscription', () => {
  // Zero cost when nobody listens: an unused `events` must not make the core build contexts for every lock.
  it('subscribes to a channel only while the event has a listener', async () => {
    const { lock } = await newApp()

    await lock.tryAcquire('a')
    expect(acquireObserved()).toBe(false)

    const listener = (): void => undefined
    lock.events.on('acquire', listener)
    expect(acquireObserved()).toBe(true)

    lock.events.off('acquire', listener)
    expect(acquireObserved()).toBe(false)
  })

  it('unsubscribes when a once listener has fired', async () => {
    const { lock } = await newApp()

    lock.events.once('acquire', () => undefined)
    await lock.tryAcquire('a')

    expect(acquireObserved()).toBe(false)
  })

  // A process that closes one application and starts another would otherwise keep every listener of the first
  // subscribed to the process-wide channels.
  it('drops every listener when the application closes', async () => {
    const { lock, close } = await newApp()
    lock.events.on('acquire', () => undefined)

    await close()

    expect(acquireObserved()).toBe(false)
    expect(lock.events.listenerCount('acquire')).toBe(0)
  })

  it('still subscribes after removeAllListeners()', async () => {
    const { lock } = await newApp()
    lock.events.on('acquire', () => undefined)
    lock.events.removeAllListeners()
    expect(acquireObserved()).toBe(false)

    const seen: string[] = []
    lock.events.on('acquire', ctx => seen.push(ctx.key))
    await lock.tryAcquire('a')

    expect(seen).toEqual(['a'])
  })
})

describe('DistLock.events containment', () => {
  // A listener runs inside a channel subscriber, inside lock code. Its failure must stay its own: the lock keeps
  // working, the process keeps running, and the log hears about it once rather than at the rate locks are taken.
  it('logs a throwing listener once and keeps the lock working', async () => {
    const { lock, log } = await newApp()
    lock.events.on('acquire', () => {
      throw new Error('listener broke')
    })

    const first = await lock.tryAcquire('a')
    const second = await lock.tryAcquire('b')
    await first!.release()

    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(await lock.tryAcquire('a')).toBeDefined()

    const warnings = log.at('warn')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.fields).toMatchObject({ event: 'acquire' })
    expect(warnings[0]!.fields.err).toBeInstanceOf(Error)
  })

  it('logs a rejecting listener once, without an unhandled rejection', async () => {
    const { lock, log } = await newApp()
    lock.events.on('acquire', async () => {
      throw new Error('listener rejected')
    })

    await lock.tryAcquire('a')
    await lock.tryAcquire('b')
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(log.at('warn')).toHaveLength(1)
    expect(log.at('warn')[0]!.fields).toMatchObject({ event: 'acquire' })
  })
})

describe('DistLockBuilder.on', () => {
  // The listener is attached as the service is built, so it hears about a lock another binding takes while the
  // application bootstraps — which a listener added after ready() never could.
  it('hears locks taken while another binding bootstraps', async () => {
    const seen: string[] = []

    class Migrations implements OnBootstrap {
      readonly #lock: DistLock

      constructor(lock: DistLock) {
        this.#lock = lock
      }

      async onBootstrap(): Promise<void> {
        await this.#lock.withLock('migrations', () => undefined)
      }
    }

    await newApp(
      d =>
        d.on('acquire', ctx => seen.push(`acquire:${ctx.key}`)).on('release', ctx => seen.push(`release:${ctx.key}`)),
      container =>
        container.bind(Migrations, t =>
          t.toFactory(ctx => new Migrations(ctx.container.get(kDistLock))).lifetime(Scopes.SINGLETON),
        ),
    )

    expect(seen).toEqual(['acquire:migrations', 'release:migrations'])
  })

  it('adds a listener with every call instead of replacing the last one', async () => {
    const seen: string[] = []
    const { lock } = await newApp(d =>
      d.on('acquire', () => seen.push('first')).on('acquire', () => seen.push('second')),
    )

    await lock.tryAcquire('a')

    expect(seen).toEqual(['first', 'second'])
  })
})
