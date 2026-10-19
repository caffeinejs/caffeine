import type { SignalDispatcher, ShutdownSignal } from './signals.js'

/** Conventional exit codes for a process terminated by a signal (128 + signal number). */
const FORCED_EXIT_CODES: Readonly<Record<ShutdownSignal, number>> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
  SIGQUIT: 131,
}

/**
 * Installs the signal handlers that start a graceful shutdown, and owns what happens when someone runs out of
 * patience and sends a second one.
 *
 * On by default, because the alternative is the single most common orchestration bug in Node services: a process
 * that ignores `SIGTERM` drops every in-flight request on every rolling deploy, and nothing about it looks broken
 * until a user reports it.
 *
 * The happy path records an exit code and lets the event loop empty on its own rather than terminating, which
 * would truncate whatever the runtime had buffered — including the logs explaining the shutdown.
 *
 * Every host interaction goes through a {@link SignalDispatcher}, so this works unchanged on Node, Bun and Deno,
 * degrades to nothing where there are no signals, and is testable without touching the real process.
 */
export class GracefulShutdown {
  readonly #close: () => Promise<void>
  readonly #dispatcher: SignalDispatcher
  readonly #handlers = new Map<ShutdownSignal, () => void>()
  #shuttingDown = false

  constructor(close: () => Promise<void>, dispatcher: SignalDispatcher) {
    this.#close = close
    this.#dispatcher = dispatcher
  }

  /** Whether a shutdown is already running. */
  get shuttingDown(): boolean {
    return this.#shuttingDown
  }

  /** Installs a handler per signal. Passing `false` installs none. */
  install(signals: readonly ShutdownSignal[] | false): void {
    if (signals === false) {
      return
    }

    for (const signal of signals) {
      if (this.#handlers.has(signal)) {
        continue
      }

      const handler = (): void => this.#onSignal(signal)
      this.#handlers.set(signal, handler)
      this.#dispatcher.on(signal, handler)
    }
  }

  /** Removes every installed handler, so a closed application leaves nothing behind on the process. */
  uninstall(): void {
    for (const [signal, handler] of this.#handlers) {
      this.#dispatcher.off(signal, handler)
    }

    this.#handlers.clear()
  }

  #onSignal(signal: ShutdownSignal): void {
    // A second signal means someone is waiting and the drain is taking too long. Honour that immediately —
    // a framework that ignores the second Ctrl+C teaches people to reach for `kill -9`.
    if (this.#shuttingDown) {
      this.#dispatcher.exit(FORCED_EXIT_CODES[signal])
      return
    }

    this.#shuttingDown = true

    this.#close().then(
      () => {
        this.#dispatcher.setExitCode(0)
      },
      (error: unknown) => {
        this.#dispatcher.error('Caffeine: graceful shutdown failed', error)
        this.#dispatcher.setExitCode(1)
      },
    )
  }
}
