/**
 * The signals a graceful shutdown can be triggered by. A local union rather than `NodeJS.Signals`, so nothing in
 * the shutdown path depends on Node's type definitions being installed.
 */
export const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'] as const

export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number]

/**
 * Everything the graceful shutdown needs from the host runtime, behind one interface.
 *
 * Signals are a process concept, and not every runtime has processes: workers and edge runtimes have no `process`
 * global at all, and reaching for one there is a `ReferenceError` at startup rather than a missing feature. The
 * seam lets the shutdown degrade to a no-op where signals do not exist, lets Node, Bun and Deno share one
 * implementation, and lets an adapter supply native handling of its own.
 */
export interface SignalDispatcher {
  on(signal: ShutdownSignal, handler: () => void): void
  off(signal: ShutdownSignal, handler: () => void): void

  /** Terminates immediately. Reserved for the second signal — the clean path uses {@link setExitCode}. */
  exit(code: number): void

  /** Records the code to exit with once the event loop empties, without truncating buffered output. */
  setExitCode(code: number): void

  warn(message: string): void
  error(message: string, error: unknown): void
}

/** The warning type every graceful-shutdown diagnostic is tagged with, so callers can filter on it. */
export const WARNING_TYPE = 'CaffeineShutdownWarning'

interface ProcessLike {
  exitCode?: number | string | null
  on(signal: string, handler: () => void): unknown
  removeListener(signal: string, handler: () => void): unknown
  exit(code?: number): never
  emitWarning?(warning: string, type?: string): void
}

/** Whether the current runtime exposes a signal-capable `process`. True on Node, Bun and Deno's compat layer. */
export function hasProcessSignals(): boolean {
  const candidate = (globalThis as { process?: ProcessLike }).process

  return candidate !== undefined && typeof candidate.on === 'function' && typeof candidate.removeListener === 'function'
}

/** A dispatcher backed by the host `process`. Only valid where {@link hasProcessSignals} holds. */
export function processSignalDispatcher(): SignalDispatcher {
  const host = (globalThis as unknown as { process: ProcessLike }).process

  return {
    on(signal, handler) {
      host.on(signal, handler)
    },
    off(signal, handler) {
      host.removeListener(signal, handler)
    },
    exit(code) {
      host.exit(code)
    },
    setExitCode(code) {
      host.exitCode = code
    },
    warn(message) {
      if (typeof host.emitWarning === 'function') {
        host.emitWarning(message, WARNING_TYPE)
      } else {
        console.warn(`${WARNING_TYPE}: ${message}`)
      }
    },
    error(message, error) {
      console.error(message, error)
    },
  }
}

/** A dispatcher for runtimes without signals: every operation is a no-op, so nothing throws on startup. */
export const noopSignalDispatcher: SignalDispatcher = {
  on() {
    // No signals to subscribe to.
  },
  off() {
    // Nothing was ever subscribed.
  },
  exit() {
    // Termination is the host's business here, not the framework's.
  },
  setExitCode() {
    // No exit code to record.
  },
  warn() {
    // No diagnostic channel; staying silent beats inventing one.
  },
  error() {
    // As above.
  },
}

let detected: SignalDispatcher | undefined

/** The dispatcher for the current runtime, resolved once. */
export function detectSignalDispatcher(): SignalDispatcher {
  detected ??= hasProcessSignals() ? processSignalDispatcher() : noopSignalDispatcher
  return detected
}
