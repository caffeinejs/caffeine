import { channel, tracingChannel, type TracingChannel } from 'node:diagnostics_channel'

import {
  DIST_LOCK_CHANNELS,
  type AcquireContext,
  type ContendedMessage,
  type ExtendContext,
  type LostMessage,
  type OnceContext,
  type ReleaseContext,
  type WithLockContext,
} from './observability/channels.js'

// The core fills a context in as the call progresses; subscribers only ever see the readonly view.
export type Writable<T> = { -readonly [K in keyof T]: T[K] }

export const acquireChannel = tracingChannel<Writable<AcquireContext>>(DIST_LOCK_CHANNELS.acquire)
export const withLockChannel = tracingChannel<Writable<WithLockContext>>(DIST_LOCK_CHANNELS.withLock)
export const onceChannel = tracingChannel<Writable<OnceContext>>(DIST_LOCK_CHANNELS.once)
export const extendChannel = tracingChannel<Writable<ExtendContext>>(DIST_LOCK_CHANNELS.extend)
export const releaseChannel = tracingChannel<Writable<ReleaseContext>>(DIST_LOCK_CHANNELS.release)

const contendedChannel = channel(DIST_LOCK_CHANNELS.contended)
const lostChannel = channel(DIST_LOCK_CHANNELS.lost)

// Runs `fn` inside the tracing channel, or bare when nobody listens: no context is built and no wrapper runs.
export function traced<C extends object, R>(
  tc: TracingChannel<C>,
  context: () => C,
  fn: (ctx: C | undefined) => Promise<R>,
): Promise<R> {
  if (!tc.hasSubscribers) {
    return fn(undefined)
  }

  const ctx = context()

  return tc.tracePromise(() => fn(ctx), ctx)
}

export function publishContended(message: () => ContendedMessage): void {
  if (contendedChannel.hasSubscribers) {
    contendedChannel.publish(message())
  }
}

export function publishLost(message: () => LostMessage): void {
  if (lostChannel.hasSubscribers) {
    lostChannel.publish(message())
  }
}
