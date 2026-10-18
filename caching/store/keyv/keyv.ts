import { randomUUID } from 'node:crypto'

import { DURATION_PATTERN, parseDuration, type Duration } from '@caffeinejs/std/duration'
import { errMessage } from '@caffeinejs/std/framework/err'

import type {
  HTTPCacheCallOptions,
  HTTPCacheEntry,
  HTTPCacheGetOptions,
  HTTPCachePutOptions,
  HTTPCacheStore,
} from '../../http/store.js'

/** Thrown for a {@link KeyvHTTPCacheStore} that is set up in a way it cannot serve. */
export class ErrKeyvCache extends Error {
  readonly code = 'ERR_KEYV_CACHE'

  constructor(message: string) {
    super(message)
    this.name = 'ErrKeyvCache'
  }
}

const DEFAULT_PREFIX = 'caffeine:cache:'

const DURATION = new RegExp(DURATION_PATTERN)

/**
 * The part of a `Keyv` this store calls. A `Keyv` satisfies it, and so does a cache-manager `Cache`, whose stores
 * are `Keyv`s.
 *
 * `ttl` is required, and in milliseconds: this store always decides how long what it writes is kept, so the
 * backend's own default `ttl` never applies to an entry or a marker. A backend whose `set` takes `ttl` optionally
 * still satisfies this.
 *
 * `get` hands back `unknown` rather than the string that was stored: `Keyv.get` is a set of overloads, and
 * pinning it to a concrete signature here is what breaks on an upstream release. The reply is coerced instead.
 */
export interface KeyvHTTPCacheClient {
  get(key: string): Promise<unknown>
  set(key: string, value: string, ttl: number): Promise<unknown>
}

export interface KeyvHTTPCacheStoreOptions {
  /**
   * Put in front of every key this store writes, as given: no separator is added. Defaults to `caffeine:cache:`;
   * `''` puts nothing in front.
   */
  prefix?: string
  /**
   * How long a tag marker is kept: a non-negative duration. Defaults to `0` — never expires, which is what the
   * counters of the Redis and memory stores do.
   *
   * Set it to bound the marker keyspace, and keep it well above the longest `ttl` plus the longest stale window:
   * a marker that lapses takes every entry recorded under it down with it, since what they recorded no longer
   * matches, so the entries under a tag miss at least once per `tagTtl`. That is over-eviction — a lost hit, never
   * a stale response.
   */
  tagTtl?: Duration
}

// s status code · k payload kind (s string, b Buffer) · p the payload, base64 when it is bytes · h headers ·
// t etag · l last-modified · a stored at · g the marker of each tag the entry was written under.
interface HTTPEnvelope {
  s: number
  k: 's' | 'b'
  p: string
  h: HTTPCacheEntry['headers']
  t?: string
  l?: string
  a?: number
  g?: Record<string, string>
}

/**
 * An {@link HTTPCacheStore} on a `Keyv` — or on a cache-manager `Cache`, whose stores are `Keyv`s, or on anything
 * else satisfying {@link KeyvHTTPCacheClient}.
 *
 * The cache is the caller's: this store never creates, connects or disconnects it.
 *
 * An entry is one JSON string, written whole on every put, its payload base64 when it is bytes. What a backend
 * serializes is therefore always a string, which every Keyv adapter round-trips.
 *
 * A tag is a marker: an entry records the marker of each of its tags when it is stored, and reads as absent once
 * any of them has changed. `evictByTag` writes a fresh marker per tag and touches no entry; the entry goes when
 * it is next read, overwritten, or expired. Unlike a counter a marker cannot come round again. A marker that is
 * gone — lapsed past `tagTtl`, or dropped by a backend that evicts under memory pressure — counts as changed: `put`
 * writes one for a tag that has none, so no entry records an absent marker. That write can replace the marker of an
 * eviction landing during the `put`, whose entry is then served: the race any request in flight during an eviction
 * has.
 *
 * Neither cache-manager nor Keyv takes an `AbortSignal`. A call whose signal is already aborted is refused, but
 * one already issued runs to completion even after the cache has given up waiting for it.
 *
 * Both backends hide failures by default, which costs the cache its error reporting rather than its correctness:
 * cache-manager's `get` reads a broken store as a miss, and Keyv resolves instead of rejecting unless it was
 * built with `throwOnErrors: true`.
 *
 * @throws ErrKeyvCache When `tagTtl` is not a non-negative duration.
 */
export class KeyvHTTPCacheStore implements HTTPCacheStore {
  readonly #client: KeyvHTTPCacheClient
  readonly #prefix: string
  readonly #tagTtlMs: number

  constructor(client: KeyvHTTPCacheClient, options?: KeyvHTTPCacheStoreOptions) {
    this.#client = client
    this.#prefix = options?.prefix ?? DEFAULT_PREFIX
    this.#tagTtlMs = tagTtlOf(options?.tagTtl)
  }

  // The entry and the markers of the hinted tags are read together. Only a tag the entry carries that the hint
  // did not name costs a second batch.
  async get(key: string, options?: HTTPCacheGetOptions): Promise<HTTPCacheEntry | undefined> {
    options?.signal?.throwIfAborted()

    const hinted = options?.tags ?? []
    const hintedKeys = hinted.map(tag => this.#tagKey(tag))
    const [raw, ...markers] = await Promise.all([
      this.#client.get(this.#entryKey(key)),
      ...hintedKeys.map(tagKey => this.#client.get(tagKey)),
    ])

    if (raw === null || raw === undefined) {
      return undefined
    }

    const envelope = JSON.parse(String(raw)) as HTTPEnvelope
    const recorded = envelope.g
    if (recorded !== undefined) {
      const current = new Map<string, string | undefined>()
      hinted.forEach((tag, i) => current.set(tag, marker(markers[i])))

      const unhinted = Object.keys(recorded).filter(tag => !current.has(tag))
      if (unhinted.length > 0) {
        const more = await Promise.all(unhinted.map(tag => this.#client.get(this.#tagKey(tag))))
        unhinted.forEach((tag, i) => current.set(tag, marker(more[i])))
      }

      for (const tag in recorded) {
        if (recorded[tag] !== current.get(tag)) {
          return undefined
        }
      }
    }

    return decodeEntry(envelope)
  }

  // A ttl of 0 means "never expires" to both backends, so a ttl that is not positive must not reach one — and
  // nothing is read for it either.
  async put(key: string, entry: HTTPCacheEntry, options: HTTPCachePutOptions): Promise<void> {
    options.signal?.throwIfAborted()

    const ms = Math.ceil(parseDuration(options.ttl) * 1000)
    if (!(ms > 0) || !Number.isFinite(ms)) {
      return
    }

    const tags = options.tags ?? []

    // Read together, once for the call, and a tag with no marker gets one before the entry is written: an entry
    // that recorded an absent marker would match again once a later marker is gone. An eviction landing between
    // the read and the write leaves an entry under an existing marker, which then reads as changed; a marker this
    // call creates replaces the eviction's instead, since neither backend can write only if absent.
    let markers: Record<string, string> | undefined
    if (tags.length > 0) {
      const distinct = [...new Set(tags)]
      const current = await Promise.all(distinct.map(tag => this.#client.get(this.#tagKey(tag))))
      const recorded: Record<string, string> = {}
      const written: Promise<unknown>[] = []
      distinct.forEach((tag, i) => {
        const existing = marker(current[i])
        if (existing === undefined) {
          recorded[tag] = randomUUID()
          written.push(this.#client.set(this.#tagKey(tag), recorded[tag], this.#tagTtlMs))
        } else {
          recorded[tag] = existing
        }
      })
      await Promise.all(written)
      markers = recorded
    }

    await this.#client.set(this.#entryKey(key), JSON.stringify(envelopeOf(entry, markers)), ms)
  }

  async evictByTag(tags: string | readonly string[], options?: HTTPCacheCallOptions): Promise<void> {
    options?.signal?.throwIfAborted()

    const list = typeof tags === 'string' ? [tags] : tags
    if (list.length === 0) {
      return
    }

    await Promise.all(list.map(tag => this.#client.set(this.#tagKey(tag), randomUUID(), this.#tagTtlMs)))
  }

  // `e:` entries and `t:` tag markers. Without the split an entry and a tag of the same name share a key.
  #entryKey(key: string): string {
    return `${this.#prefix}e:${key}`
  }

  #tagKey(tag: string): string {
    return `${this.#prefix}t:${tag}`
  }
}

// `parseDuration` reads what it cannot parse as 0, and `-5s` as 5: either would pass for a marker lifetime.
function tagTtlOf(tagTtl: Duration | undefined): number {
  if (tagTtl === undefined) {
    return 0
  }

  // Checked before rounding: a negative fraction of a millisecond would round to 0, which means never expires.
  const seconds = parseDuration(tagTtl)
  if (!((typeof tagTtl === 'number' || DURATION.test(tagTtl)) && Number.isFinite(seconds) && seconds >= 0)) {
    throw new ErrKeyvCache(
      errMessage(`Cannot create a Keyv cache with the tagTtl "${String(tagTtl)}": it is not a non-negative duration`)
        .solutions(
          'Write tagTtl as duration text such as "1h", or as a number of seconds',
          'Leave tagTtl unset, or set it to 0, for markers that never expire',
        )
        .reference('@caffeinejs/caching', ErrKeyvCache)
        .build(),
    )
  }

  return seconds === 0 ? 0 : Math.ceil(seconds * 1000)
}

// An absent marker — never written, lapsed, or dropped by the backend — reads as `undefined`, which no entry
// records.
function marker(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value)
}

function envelopeOf(entry: HTTPCacheEntry, markers: Record<string, string> | undefined): HTTPEnvelope {
  const bytes = Buffer.isBuffer(entry.payload)

  return {
    s: entry.statusCode,
    k: bytes ? 'b' : 's',
    p: bytes ? entry.payload.toString('base64') : (entry.payload as string),
    h: entry.headers,
    t: entry.etag,
    l: entry.lastModified,
    a: entry.storedAt,
    g: markers,
  }
}

function decodeEntry(envelope: HTTPEnvelope): HTTPCacheEntry {
  const entry: HTTPCacheEntry = {
    payload: envelope.k === 'b' ? Buffer.from(envelope.p, 'base64') : envelope.p,
    statusCode: envelope.s,
    headers: envelope.h,
  }

  if (envelope.t !== undefined) {
    entry.etag = envelope.t
  }
  if (envelope.l !== undefined) {
    entry.lastModified = envelope.l
  }
  if (envelope.a !== undefined) {
    entry.storedAt = envelope.a
  }

  return entry
}
