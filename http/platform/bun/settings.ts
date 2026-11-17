import type { ListenOptions } from 'node:net'

import { configurationError, USE_NODE } from '../../core/server/error.js'
import {
  assertObjectSections,
  resolveServerSettings,
  SOCKET_SECTIONS,
  type ApplicationKind,
  type ListeningServerSettings,
  type ResolvedServerSettings,
} from '../../core/server/settings.js'
import type { BunServeOptions, BunTLS } from './runtime.js'

/** Where `bun()` listens, in node:net's names, so a `listen` section reads the same under `node()`. */
export type BunListen = Pick<ListenOptions, 'host' | 'port' | 'path' | 'reusePort' | 'ipv6Only'>

/** What `.server(...)` returns under `bun()`. */
export interface BunServerSettings extends ListeningServerSettings {
  /**
   * Where to listen, in node:net's names: `host`, `port`, `path` (a Unix socket), `reusePort`, `ipv6Only`, bound as
   * node:net binds them. `run(options)` merges over it, key by key. With no `host` and no `path`, `localhost`; with
   * nothing at all, also a port the OS assigns.
   */
  listen?: BunListen
  /** Serves TLS: the key and certificate, as node:https takes them. */
  https?: BunTLS
}

/** {@link BunServerSettings}, checked: the engine's settings, and what `Bun.serve` takes. */
export interface ResolvedBunSettings {
  readonly engine: ResolvedServerSettings
  readonly listen: BunListen | undefined
  readonly tls: BunTLS | undefined
}

const BUN_APPLICATION: ApplicationKind = {
  name: 'Bun application',
  sections: SOCKET_SECTIONS,
  peerAddress: true,
}

const OBJECT_SECTIONS = {
  listen: ['node:net options', '{ port: 3000 }'],
  https: ['TLS options', '{ key, cert }'],
} as const

/** @throws ErrConfiguration for what `resolveServerSettings` refuses, and for a section that is not an object. */
export function resolveBunServerSettings(settings: object): ResolvedBunSettings {
  const engine = resolveServerSettings(settings, BUN_APPLICATION)
  const { listen, https } = settings as Record<string, unknown>

  assertObjectSections(settings, OBJECT_SECTIONS)

  if (https !== undefined) {
    assertBunTLS(https as Record<string, unknown>)
  }

  return { engine, listen: listen as BunListen | undefined, tls: https as BunTLS | undefined }
}

/** The node:https options Bun's `tls` takes. */
const BUN_TLS: ReadonlySet<string> = new Set(['key', 'cert', 'ca', 'passphrase'])

/**
 * Refuses TLS Bun would not serve as written: an option it does not take, or no key and certificate to serve with.
 *
 * @throws ErrConfiguration naming the option or what is missing.
 */
function assertBunTLS(https: Record<string, unknown>): void {
  for (const key of Object.keys(https)) {
    if (!BUN_TLS.has(key)) {
      throw configurationError(
        `Cannot serve TLS with "${key}" under bun(): Bun.serve does not take it`,
        `Leave ${key} out of https`,
        `${USE_NODE} to serve TLS with it on Node`,
      )
    }
  }

  if (https.key == null || https.cert == null) {
    throw configurationError(
      'Cannot serve TLS: the https section needs a key and a cert',
      'Add the key and the certificate to https, such as { key, cert }',
      'Leave https out to serve without TLS',
    )
  }
}

/** The node:net options Bun takes, under their node:net names. */
const BUN_LISTEN: ReadonlySet<string> = new Set(['host', 'port', 'path', 'reusePort', 'ipv6Only'])

/**
 * Bun's listen options for `listen` merged under `run(options)`, key by key, bound as node:net binds them: a port wins
 * over a path, and `localhost` is the host when neither a host nor a path is set. With nothing set at all, a port the
 * OS assigns, so Bun never falls back to its own default, 3000 or `$PORT`.
 *
 * @throws ErrConfiguration for an option Bun does not take, and for a host with no port and no path.
 */
export function bunListenOptions(
  listen: BunListen | undefined,
  run: BunListen | undefined,
): Pick<BunServeOptions, 'hostname' | 'port' | 'unix' | 'reusePort' | 'ipv6Only'> {
  const merged = { ...listen, ...run }

  for (const key of Object.keys(merged)) {
    if (!BUN_LISTEN.has(key)) {
      throw configurationError(
        `Cannot listen with "${key}" under bun(): Bun.serve does not take it`,
        `Leave ${key} out of listen`,
        `${USE_NODE} to listen with it on Node`,
      )
    }
  }

  const { host, port, path, reusePort, ipv6Only } = merged

  if (Object.keys(merged).length === 0) {
    return { hostname: 'localhost', port: 0 }
  }

  if (port != null) {
    return {
      ...(host == null && path == null ? { hostname: 'localhost' } : host == null ? {} : { hostname: host }),
      port,
      ...(reusePort === undefined ? {} : { reusePort }),
      ...(ipv6Only === undefined ? {} : { ipv6Only }),
    }
  }

  if (path != null) {
    return { unix: path }
  }

  throw configurationError(
    'Cannot listen: "listen" names no port and no path',
    'Add a port, such as port: 0 for one the OS assigns',
    'Add a path, to listen on a Unix socket',
  )
}
