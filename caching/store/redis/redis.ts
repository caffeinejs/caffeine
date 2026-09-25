import { parseDuration } from '@caffeinejs/std/duration'
import { RESP_TYPES } from '@redis/client'

import type {
  HTTPCacheCallOptions,
  HTTPCacheEntry,
  HTTPCacheGetOptions,
  HTTPCachePutOptions,
  HTTPCacheStore,
} from '../../http/store.js'

/** Thrown for a {@link RedisHTTPCacheStore} that is set up, or called, in a way it cannot serve. */
export class ErrRedisCache extends Error {
  readonly code = 'ERR_REDIS_CACHE'

  constructor(message: string) {
    super(message)
    this.name = 'ErrRedisCache'
  }
}

const DEFAULT_PREFIX = 'caffeine:cache:'

// p the payload, as the bytes it was given · m everything else about the entry, as JSON. Both are written on
// every put: HSETEX leaves a field it does not name in place, so an entry made of a fixed set of fields can
// never inherit one from the entry it replaces.
const FIELDS = ['p', 'm']

type BufferMapping = { [RESP_TYPES.BLOB_STRING]: typeof Buffer }

// One view whose bulk replies are Buffers, so a payload comes back as the bytes that went in.
const BUFFER_MAPPING: BufferMapping = { [RESP_TYPES.BLOB_STRING]: Buffer }

/** The commands {@link RedisHTTPCacheStore} sends. Every one of them names a single key. */
export interface RedisHTTPCacheCommands {
  get(key: string): Promise<unknown>
  hmGet(key: string, fields: string[]): Promise<unknown>
  hSetEx(
    key: string,
    fields: Record<string, string | Buffer>,
    options: { expiration: { type: 'PX'; value: number } },
  ): Promise<unknown>
  incr(key: string): Promise<unknown>
}

/** What `withTypeMapping` hands back: the commands, and on a single-server client a way to bind a signal to them. */
export interface RedisHTTPCacheView extends RedisHTTPCacheCommands {
  withAbortSignal?(signal: AbortSignal): RedisHTTPCacheCommands
}

/**
 * The part of a node-redis client this store calls. A client from `createClient()` and one from
 * `createCluster()` both satisfy it, imported from `@redis/client` or from `redis`, which re-exports it.
 *
 * A call with a signal binds it through `withAbortSignal` where the client has it, which keeps the client's own
 * command options. A cluster client has no `withAbortSignal`, so the signal goes through `withCommandOptions`,
 * which replaces those options: on a cluster, a call runs under the cache's `storeTimeout` and not the client's
 * command timeout.
 */
export interface RedisHTTPCacheClient {
  withTypeMapping(typeMapping: BufferMapping): RedisHTTPCacheView
  withCommandOptions(options: { typeMapping: BufferMapping; abortSignal: AbortSignal }): RedisHTTPCacheCommands
}

export interface RedisHTTPCacheStoreOptions {
  /**
   * Put in front of every key this store writes, as given: no separator is added. Defaults to `caffeine:cache:`;
   * `''` puts nothing in front. May not hold `{` or `}`.
   */
  prefix?: string
}

// s status code · k payload kind (s string, b Buffer) · h headers · t etag · l last-modified · a stored at ·
// g the generation of each tag the entry was written under.
interface HTTPMeta {
  s: number
  k: 's' | 'b'
  h: HTTPCacheEntry['headers']
  t?: string
  l?: string
  a?: number
  g?: Record<string, string>
}

/**
 * An {@link HTTPCacheStore} on one Redis or Valkey server, or on a cluster of them.
 *
 * The client is the caller's, from `createClient()` or `createCluster()`: it is expected connected, and this
 * store never connects, closes, or reconnects it.
 *
 * Needs Redis 8.0 or Valkey 9.0: an entry is written with `HSETEX`, and an older server rejects every write.
 *
 * An entry is one hash, its payload stored as the bytes it was given. A tag is a counter: an entry records the
 * counter of each of its tags when it is stored, and reads as absent once one of them has moved on.
 * `evictByTag` is one `INCR` per tag, whatever the tags cover; the entry itself goes when it is next overwritten
 * or expires. No command names more than one key, and nothing walks the keyspace, so a cluster client needs
 * nothing more: a call's commands are sent together and spread over the cluster.
 *
 * Counters have no `ttl`. Under an `allkeys-*` eviction policy the server may evict one, which restarts the
 * tag's count: an entry written under a number that comes round again is readable until its own `ttl`. Run the
 * server with `noeviction` or a `volatile-*` policy.
 *
 * @throws ErrRedisCache When `prefix` holds a brace.
 */
export class RedisHTTPCacheStore implements HTTPCacheStore {
  readonly #client: RedisHTTPCacheClient
  readonly #view: RedisHTTPCacheView
  readonly #prefix: string

  constructor(client: RedisHTTPCacheClient, options?: RedisHTTPCacheStoreOptions) {
    this.#prefix = options?.prefix ?? DEFAULT_PREFIX

    // Redis hashes the first `{...}` of a key, so a brace would decide the slot.
    if (hasBrace(this.#prefix)) {
      throw new ErrRedisCache(`Cannot create a Redis cache with the prefix "${this.#prefix}": it holds a brace`)
    }

    this.#client = client
    this.#view = client.withTypeMapping(BUFFER_MAPPING)
  }

  // The entry and the counters of the hinted tags are read together. Only a tag the entry carries that the hint
  // did not name costs a second batch.
  async get(key: string, options?: HTTPCacheGetOptions): Promise<HTTPCacheEntry | undefined> {
    options?.signal?.throwIfAborted()

    // Every key is derived before a command goes out, so a tag that is refused sends nothing.
    const hinted = options?.tags ?? []
    const hintedKeys = hinted.map(tag => this.#tagKey(tag))
    const commands = this.#commands(options?.signal)
    const [fields, ...counters] = await Promise.all([
      commands.hmGet(this.#entryKey(key), FIELDS),
      ...hintedKeys.map(tagKey => commands.get(tagKey)),
    ])

    const [payload, meta] = fields as (Buffer | null)[]
    if (payload === null || payload === undefined || meta === null || meta === undefined) {
      return undefined
    }

    const parsed = JSON.parse(meta.toString()) as HTTPMeta
    const recorded = parsed.g
    if (recorded !== undefined) {
      const current = new Map<string, string>()
      hinted.forEach((tag, i) => current.set(tag, text(counters[i]) ?? '0'))

      const unhinted = Object.keys(recorded).filter(tag => !current.has(tag))
      if (unhinted.length > 0) {
        const unhintedKeys = unhinted.map(tag => this.#tagKey(tag))
        const more = await Promise.all(unhintedKeys.map(tagKey => commands.get(tagKey)))
        unhinted.forEach((tag, i) => current.set(tag, text(more[i]) ?? '0'))
      }

      for (const tag in recorded) {
        if (recorded[tag] !== current.get(tag)) {
          return undefined
        }
      }
    }

    return decodeEntry(payload, parsed)
  }

  async put(key: string, entry: HTTPCacheEntry, options: HTTPCachePutOptions): Promise<void> {
    options.signal?.throwIfAborted()

    const ms = Math.ceil(parseDuration(options.ttl) * 1000)
    if (!(ms > 0) || !Number.isFinite(ms)) {
      return
    }

    const tags = options.tags ?? []
    const tagKeys = tags.map(tag => this.#tagKey(tag))
    const commands = this.#commands(options.signal)

    // Read together, once for the call. An eviction landing between this and the write leaves an entry under the
    // earlier count, which reads as absent.
    let generations: Record<string, string> | undefined
    if (tags.length > 0) {
      const counters = await Promise.all(tagKeys.map(tagKey => commands.get(tagKey)))
      generations = {}
      tags.forEach((tag, i) => (generations![tag] = text(counters[i]) ?? '0'))
    }

    // Both fields on every put: HSETEX leaves a field it does not name in place, so an entry made of a fixed set
    // of fields can never inherit one from the entry it replaces.
    await commands.hSetEx(
      this.#entryKey(key),
      { p: entry.payload, m: JSON.stringify(httpMetaOf(entry, generations)) },
      { expiration: { type: 'PX', value: ms } },
    )
  }

  async evictByTag(tags: string | readonly string[], options?: HTTPCacheCallOptions): Promise<void> {
    options?.signal?.throwIfAborted()

    const list = typeof tags === 'string' ? [tags] : tags
    if (list.length === 0) {
      return
    }

    const tagKeys = list.map(tag => this.#tagKey(tag))
    const commands = this.#commands(options?.signal)
    await Promise.all(tagKeys.map(tagKey => commands.incr(tagKey)))
  }

  #commands(signal: AbortSignal | undefined): RedisHTTPCacheCommands {
    if (signal === undefined) {
      return this.#view
    }

    return this.#view.withAbortSignal
      ? this.#view.withAbortSignal(signal)
      : this.#client.withCommandOptions({ typeMapping: BUFFER_MAPPING, abortSignal: signal })
  }

  // `e:` entries and `t:` tag counters. `l:` is kept free for per-key locks beside the entries they guard.
  #entryKey(key: string): string {
    return `${this.#prefix}e:${key}`
  }

  #tagKey(tag: string): string {
    if (hasBrace(tag)) {
      throw new ErrRedisCache(`Cannot use the tag "${tag}" on a Redis cache: it holds a brace`)
    }

    return `${this.#prefix}t:${tag}`
  }
}

function hasBrace(value: string): boolean {
  return value.includes('{') || value.includes('}')
}

function text(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined
  }

  return Buffer.isBuffer(value) ? value.toString() : String(value)
}

function httpMetaOf(entry: HTTPCacheEntry, generations: Record<string, string> | undefined): HTTPMeta {
  return {
    s: entry.statusCode,
    k: Buffer.isBuffer(entry.payload) ? 'b' : 's',
    h: entry.headers,
    t: entry.etag,
    l: entry.lastModified,
    a: entry.storedAt,
    g: generations,
  }
}

function decodeEntry(payload: Buffer, meta: HTTPMeta): HTTPCacheEntry {
  const entry: HTTPCacheEntry = {
    payload: meta.k === 'b' ? payload : payload.toString(),
    statusCode: meta.s,
    headers: meta.h,
  }

  if (meta.t !== undefined) {
    entry.etag = meta.t
  }
  if (meta.l !== undefined) {
    entry.lastModified = meta.l
  }
  if (meta.a !== undefined) {
    entry.storedAt = meta.a
  }

  return entry
}
