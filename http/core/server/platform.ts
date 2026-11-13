import type { IContextPlatform } from '../../adapter.js'

/** What goes out as a body: text, bytes, a stream, or none. */
export type SendPayload = string | Uint8Array | ReadableStream<Uint8Array> | null

/** The status and headers of an answer, lower-case names. */
export interface ResponseHead {
  readonly status: number
  readonly headers: Readonly<Record<string, string | readonly string[]>>
}

/** What the engine hands `respond`: how to say the answer has left, and how to cut it while it streams. */
export interface SendHooks {
  /** The answer has left: called once, at once for a whole body, when a streamed one ends. Safe to pass detached. */
  readonly sent: () => void
  /** Registers how to cut a streamed answer still being sent, for a forced close. */
  cancelWith(cancel: (reason: Error) => void): void
}

/**
 * How the engine reads one request of a runtime and answers it. `N` is what the runtime hands per request, `P` is
 * `ctx.platform`, `R` is what its entry returns.
 */
export interface ServerPlatform<N, P extends IContextPlatform, R> {
  readonly name: P['name']
  method(native: N): string
  /** Path and query as sent, before the base path is taken off. */
  target(native: N): string
  /** `http` or `https`. */
  protocol(native: N): string
  /** A request header by name, in any case. */
  header(native: N, name: string): string | undefined
  /** Every request header, by lower-case name. */
  headers(native: N): Record<string, string>
  request(native: N): Request
  /** Aborts when the client leaves. */
  signal(native: N): AbortSignal
  remoteAddress(native: N): string | undefined
  /** `extra` is what the runtime handed its entry after the request. */
  context(native: N, extra: unknown): P
  /**
   * Sends the answer; a list-valued header goes out as one field line per value. Calls `hooks.sent` once it has left,
   * and, for a stream, registers with `hooks.cancelWith` how to cut it: a reader of its body then fails with the reason.
   */
  respond(native: N, head: ResponseHead, payload: SendPayload, hooks: SendHooks): R
}
