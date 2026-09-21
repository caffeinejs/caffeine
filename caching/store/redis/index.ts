import { parseDuration, type Duration } from '@caffeinejs/std'
import { RESP_TYPES } from '@redis/client'

import type { Cache, CacheEntry, CachePutItem } from '../../store.js'

/** Thrown for a {@link RedisCache} that is set up, or called, in a way it cannot serve. */
export class ErrRedisCache extends Error {
  readonly code = 'ERR_REDIS_CACHE'

  constructor(message: string) {
    super(message)
    this.name = 'ErrRedisCache'
  }
}

/** The commands {@link RedisCache} sends. Every one of them names the keys of a single slot. */
export interface RedisCacheCommands {
  get(key: string): Promise<unknown>
  hmGet(key: string, fields: string[]): Promise<unknown>
  eval(script: string, options: { keys: string[]; arguments: (string | Buffer)[] }): Promise<unknown>
  unlink(key: string): Promise<unknown>
  incr(key: string): Promise<unknown>
}

/**
 * The part of a node-redis client this store calls. A client from `createClient()` and one from
 * `createCluster()` both satisfy it, imported from `@redis/client` or from `redis`, which re-exports it.
 */
export interface RedisCacheClient {
  withTypeMapping(typeMapping: { [RESP_TYPES.BLOB_STRING]: typeof Buffer }): RedisCacheCommands
}

export interface RedisCacheOptions {
  /** Prepended to every key this store writes. Defaults to `caffeine:cache:`. May not hold `{` or `}`. */
  prefix?: string
  /**
   * The cluster hash tag for a segment's keys. Defaults to the segment itself, so a segment lives on one shard
   * and segments spread over the cluster. Return the same tag for several segments to keep them together, or
   * `undefined` for no tag on a server that is not a cluster. A tag may not hold `{` or `}`.
   *
   * It is given the segment and never the key: an entry and the counter that clears its segment have to fall in
   * the same slot.
   */
  hashTag?: (segment: string) => string | undefined
}

const DEFAULT_PREFIX = 'caffeine:cache:'

// p payload · e payload kind (s string, b Buffer) · s status code · t etag · m last-modified · a stored at ·
// h headers as JSON · g the segment generation the entry was written under. Read with HMGET on this fixed list
// so the reply is an array under RESP2 and RESP3 alike.
const FIELDS = ['p', 'e', 's', 't', 'm', 'a', 'h', 'g']

// KEYS[1] the entry, KEYS[2] its segment counter when it has a segment. ARGV[1] the ttl in milliseconds, the rest
// field/value pairs. The entry is deleted first so an optional field of the one it replaces cannot outlive it.
const PUT = `
local fields = {}
for i = 2, #ARGV do fields[#fields + 1] = ARGV[i] end
if KEYS[2] then
  fields[#fields + 1] = 'g'
  fields[#fields + 1] = redis.call('GET', KEYS[2]) or '0'
end
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], unpack(fields))
redis.call('PEXPIRE', KEYS[1], ARGV[1])
return 1`

/**
 * A {@link Cache} on one Redis or Valkey server, or on a cluster of them.
 *
 * The client is the caller's, from `createClient()` or `createCluster()`: it is expected connected, and this
 * store never connects, closes, or reconnects it.
 *
 * An entry is one hash, its payload stored as the bytes it was given. `clear(segment)` is a single `INCR` on the
 * segment's generation counter, whatever the segment holds: an entry written under an earlier generation reads
 * as absent, and is overwritten by the next `put` under its key or removed by its `ttl`. `clear()` without a
 * segment is refused — nothing short of walking the keyspace could serve it, and this store never does.
 *
 * No command names keys from two slots, so a cluster client needs nothing more: a batch is sent as single-key
 * commands in one go, and the keys of a segment share a hash tag (see {@link RedisCacheOptions.hashTag}).
 * Entries without a segment carry no tag and spread over the cluster key by key.
 *
 * Counters have no `ttl`. Under an `allkeys-*` eviction policy the server may evict one, which restarts the
 * segment's generation: an entry written under a number that comes round again is readable until its own `ttl`.
 * Run the server with `noeviction` or a `volatile-*` policy.
 *
 * @throws ErrRedisCache When `prefix` holds a brace.
 */
export class RedisCache implements Cache {
  readonly #commands: RedisCacheCommands
  readonly #prefix: string
  readonly #hashTag: (segment: string) => string | undefined

  constructor(client: RedisCacheClient, options?: RedisCacheOptions) {
    this.#prefix = options?.prefix ?? DEFAULT_PREFIX
    this.#hashTag = options?.hashTag ?? (segment => segment)

    // Redis hashes the first `{...}` of a key, so a brace ahead of the tag would take its place.
    if (hasBrace(this.#prefix)) {
      throw new ErrRedisCache(`Cannot create a Redis cache with the prefix "${this.#prefix}": it holds a brace`)
    }

    // One view whose bulk replies are Buffers, so a payload comes back as the bytes that went in.
    this.#commands = client.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer })
  }

  async get(key: string, segment?: string): Promise<CacheEntry | undefined> {
    if (!segment) {
      return decode(await this.#commands.hmGet(this.#entryKey(key), FIELDS), undefined)
    }

    const root = this.#root(segment)
    const [generation, fields] = await Promise.all([
      this.#commands.get(counterKey(root, segment)),
      this.#commands.hmGet(entryKey(root, segment, key), FIELDS),
    ])

    return decode(fields, text(generation) ?? '0')
  }

  async getMany(keys: string[], segment?: string): Promise<(CacheEntry | undefined)[]> {
    if (keys.length === 0) {
      return []
    }

    // Single-key commands issued together: one pipeline on a server, one fan-out over the nodes of a cluster.
    const root = segment ? this.#root(segment) : this.#prefix
    const generation = segment ? this.#commands.get(counterKey(root, segment)) : undefined
    const replies = await Promise.all(keys.map(key => this.#commands.hmGet(entryKey(root, segment, key), FIELDS)))
    const current = segment ? (text(await generation) ?? '0') : undefined

    return replies.map(fields => decode(fields, current))
  }

  async put(key: string, entry: CacheEntry, ttl: Duration, segment?: string): Promise<void> {
    await this.#put(segment ? this.#root(segment) : this.#prefix, key, entry, ttl, segment)
  }

  async putMany(items: CachePutItem[], segment?: string): Promise<void> {
    const root = segment ? this.#root(segment) : this.#prefix

    await Promise.all(items.map(item => this.#put(root, item.key, item.entry, item.ttl, segment)))
  }

  async delete(key: string, segment?: string): Promise<void> {
    await this.#commands.unlink(entryKey(segment ? this.#root(segment) : this.#prefix, segment, key))
  }

  async deleteMany(keys: string[], segment?: string): Promise<void> {
    const root = segment ? this.#root(segment) : this.#prefix

    // One UNLINK for each key rather than one for all: keys without a segment fall in different slots.
    await Promise.all(keys.map(key => this.#commands.unlink(entryKey(root, segment, key))))
  }

  /** @throws ErrRedisCache Without a segment. */
  async clear(segment?: string): Promise<void> {
    if (!segment) {
      throw new ErrRedisCache(
        'Cannot clear a Redis cache without a segment: it would take a walk of the keyspace, which this store never does',
      )
    }

    await this.#commands.incr(counterKey(this.#root(segment), segment))
  }

  async #put(root: string, key: string, entry: CacheEntry, ttl: Duration, segment?: string): Promise<void> {
    const ms = Math.ceil(parseDuration(ttl) * 1000)
    if (!(ms > 0) || !Number.isFinite(ms)) {
      return
    }

    const isBuffer = Buffer.isBuffer(entry.payload)
    const fields: (string | Buffer)[] = [
      String(ms),
      'p',
      entry.payload,
      'e',
      isBuffer ? 'b' : 's',
      's',
      String(entry.statusCode),
      'h',
      JSON.stringify(entry.headers),
    ]

    if (entry.etag !== undefined) {
      fields.push('t', entry.etag)
    }
    if (entry.lastModified !== undefined) {
      fields.push('m', entry.lastModified)
    }
    if (entry.storedAt !== undefined) {
      fields.push('a', String(entry.storedAt))
    }

    const keys = segment ? [entryKey(root, segment, key), counterKey(root, segment)] : [entryKey(root, segment, key)]

    await this.#commands.eval(PUT, { keys, arguments: fields })
  }

  #entryKey(key: string): string {
    return entryKey(this.#prefix, undefined, key)
  }

  // The prefix every key of `segment` starts with, hash tag included.
  #root(segment: string): string {
    const tag = this.#hashTag(segment)
    if (tag === undefined || tag === '') {
      return this.#prefix
    }

    if (hasBrace(tag)) {
      throw new ErrRedisCache(`Cannot use the hash tag "${tag}" for segment "${segment}": it holds a brace`)
    }

    return `${this.#prefix}{${tag}}:`
  }
}

// `e:` entries and `g:` counters. `l:` is kept free for per-key locks beside the entries they guard.
// The segment is length-prefixed, so no segment is a prefix of another and an unsegmented key cannot read as a
// segmented one.
function entryKey(root: string, segment: string | undefined, key: string): string {
  return segment ? `${root}e:${segment.length}:${segment}${key}` : `${root}e:0:${key}`
}

function counterKey(root: string, segment: string): string {
  return `${root}g:${segment}`
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

// `generation` is the segment's current one, `undefined` for an entry without a segment.
function decode(reply: unknown, generation: string | undefined): CacheEntry | undefined {
  const [payload, kind, status, etag, lastModified, storedAt, headers, written] = reply as (Buffer | null)[]

  if (payload === null || payload === undefined) {
    return undefined
  }

  if (generation !== undefined && text(written) !== generation) {
    return undefined
  }

  const entry: CacheEntry = {
    payload: text(kind) === 'b' ? payload : payload.toString(),
    statusCode: Number(text(status)),
    headers: JSON.parse(text(headers) ?? '{}') as CacheEntry['headers'],
  }

  if (etag) {
    entry.etag = etag.toString()
  }
  if (lastModified) {
    entry.lastModified = lastModified.toString()
  }
  if (storedAt) {
    entry.storedAt = Number(storedAt.toString())
  }

  return entry
}
