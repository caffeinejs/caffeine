import { configurationError, USE_NODE } from '../../core/server/error.js'

/** Bun's server, as `Bun.serve` returns it: what the adapter reads, and what `app.instance` is under `bun()`. */
export interface BunServer {
  /** Where it is bound, on a TCP bind. */
  readonly address: { readonly address: string; readonly port: number } | null
  readonly hostname: string | undefined
  readonly port: number | undefined
  readonly url: URL
  /** Sets how many seconds `request`'s connection may stay silent; `0` never cuts it. */
  timeout(request: Request, seconds: number): void
  /** The peer of an active request; `null` once it has closed, and on a Unix socket. */
  requestIP(request: Request): { readonly address: string } | null
  /** Stops accepting connections; `true` also cuts those still open. Resolves once every connection has closed. */
  stop(closeActiveConnections?: boolean): Promise<void>
}

/** What Bun's `tls` takes, in node:https's names: PEM text or bytes, one or several. */
export interface BunTLS {
  readonly key?: string | Buffer | readonly (string | Buffer)[]
  readonly cert?: string | Buffer | readonly (string | Buffer)[]
  readonly ca?: string | Buffer | readonly (string | Buffer)[]
  readonly passphrase?: string
}

/** The options of `Bun.serve` the adapter passes. */
export interface BunServeOptions {
  hostname?: string
  port?: number
  unix?: string
  reusePort?: boolean
  ipv6Only?: boolean
  tls?: BunTLS
  /** Seconds a connection may stay silent; `0` never cuts it. */
  idleTimeout?: number
  fetch(request: Request, server: BunServer): Response | Promise<Response>
}

/**
 * Bun's `serve`.
 *
 * @throws ErrConfiguration when the runtime is not Bun.
 */
export function bunRuntime(): (options: BunServeOptions) => BunServer {
  const bun = (globalThis as { Bun?: { serve?: unknown } }).Bun

  if (typeof bun?.serve !== 'function') {
    throw configurationError(
      'Cannot serve with the Bun adapter: this runtime is not Bun',
      'Run the application with bun',
      `${USE_NODE} to serve on Node`,
    )
  }

  const serve = bun.serve as (options: BunServeOptions) => BunServer
  return options => serve.call(bun, options)
}
