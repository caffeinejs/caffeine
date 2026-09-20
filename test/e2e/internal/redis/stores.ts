import { createHash, randomBytes } from 'node:crypto'

import {
  Claim,
  Identity,
  OpaqueTokenStore,
  Principal,
  RefreshTokenStore,
  RememberMeTokenStore,
  type RemoteAuthenticationTicket,
  type RemoteAuthenticationTicketStore,
  type SeriesTokenRecord,
  type SeriesTokenRotation,
  type SeriesTokenStore,
} from '@caffeinejs/http'
import { createClient } from '@redis/client'

/**
 * Redis-backed stores for the authentication e2e specs.
 *
 * The package ships no production store on purpose, so these are what a deployment would write: shared between
 * instances, expiring on their own, and indexed by subject where "sign out everywhere" needs it. A credential is
 * never a key in Redis as it travels on the wire — only its SHA-256 is, so a dump of the keyspace hands out nothing
 * that still works.
 */

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'

const newClient = (url: string) => createClient({ url })
export type RedisClient = ReturnType<typeof newClient>

export async function connectRedis(url = REDIS_URL): Promise<RedisClient> {
  const client = newClient(url)
  await client.connect()
  return client
}

function digest(secret: string): string {
  return createHash('sha256').update(secret).digest('base64url')
}

/** Sessions of the OpenID Connect and OAuth 2.0 strategies, held server-side so they can be revoked. */
export class RedisTicketStore implements RemoteAuthenticationTicketStore {
  readonly #redis: RedisClient
  readonly #prefix: string

  /** @param prefix - Unique per run, so a rerun never meets what a previous one left behind. */
  constructor(redis: RedisClient, prefix: string) {
    this.#redis = redis
    this.#prefix = prefix
  }

  async store(key: string, ticket: RemoteAuthenticationTicket, ttlSeconds: number): Promise<void> {
    const id = digest(key)
    const index = this.#subject(ticket.subject)

    await this.#redis
      .multi()
      .set(this.#ticket(id), JSON.stringify(ticket), { EX: ttlSeconds })
      .sAdd(index, id)
      // The index outlives its longest ticket and no longer; a stale member is harmless, since its ticket is gone.
      .expire(index, ttlSeconds, 'GT')
      .expire(index, ttlSeconds, 'NX')
      .exec()
  }

  async retrieve(key: string): Promise<RemoteAuthenticationTicket | undefined> {
    const value = await this.#redis.get(this.#ticket(digest(key)))
    return value === null ? undefined : (JSON.parse(value) as RemoteAuthenticationTicket)
  }

  async remove(key: string): Promise<void> {
    await this.#redis.del(this.#ticket(digest(key)))
  }

  async removeBySubject(subject: string): Promise<void> {
    const index = this.#subject(subject)
    const ids = await this.#redis.sMembers(index)

    await this.#redis.del([index, ...ids.map(id => this.#ticket(id))])
  }

  #ticket(id: string): string {
    return `${this.#prefix}:ticket:${id}`
  }

  #subject(subject: string): string {
    return `${this.#prefix}:subject:${subject}`
  }
}

interface OpaqueTokenRecord {
  subject: string
  roles: string[]
}

/** Opaque bearer tokens: random on the wire, a hash in Redis, revocable the moment the key is deleted. */
export class RedisOpaqueTokenStore extends OpaqueTokenStore {
  readonly #redis: RedisClient
  readonly #prefix: string

  constructor(redis: RedisClient, prefix: string) {
    super()
    this.#redis = redis
    this.#prefix = prefix
  }

  /** Mints a token. The return value is the only place the token itself ever exists. */
  async issue(subject: string, roles: string[], ttlSeconds: number): Promise<string> {
    const token = randomBytes(32).toString('base64url')
    const record: OpaqueTokenRecord = { subject, roles }

    await this.#redis.set(this.#key(token), JSON.stringify(record), { EX: ttlSeconds })

    return token
  }

  async revoke(token: string): Promise<void> {
    await this.#redis.del(this.#key(token))
  }

  async validate(token: string): Promise<Principal | null> {
    const value = await this.#redis.get(this.#key(token))
    if (value === null) {
      return null
    }

    const record = JSON.parse(value) as OpaqueTokenRecord
    const claims = [new Claim('sub', record.subject, ''), ...record.roles.map(role => new Claim('roles', role, ''))]

    return new Principal(true, new Identity('OpaqueToken', true, claims))
  }

  #key(token: string): string {
    return `${this.#prefix}:opaque:${digest(token)}`
  }
}

/**
 * The swap `SeriesTokenStore.rotate` asks for, as one script: Redis runs it to the end before anything else, so
 * of all the requests presenting one token exactly one sees it as current.
 *
 * KEYS[1] the series. ARGV: expected hash, new hash, rotatedAt, expiresAt.
 */
const ROTATE = `
local current = redis.call('HGET', KEYS[1], 'tokenHash')
if current == false or current ~= ARGV[1] then
  return 0
end
redis.call('HSET', KEYS[1], 'tokenHash', ARGV[2], 'previousTokenHash', ARGV[1], 'rotatedAt', ARGV[3], 'expiresAt', ARGV[4])
redis.call('EXPIREAT', KEYS[1], ARGV[4])
return 1
`

/** Rotating credentials in Redis: a hash per series that expires by itself, and a set of series per subject. */
class RedisSeriesTokens implements Pick<
  SeriesTokenStore,
  'create' | 'findBySeries' | 'rotate' | 'remove' | 'removeBySubject'
> {
  readonly #redis: RedisClient
  readonly #prefix: string

  constructor(redis: RedisClient, prefix: string) {
    this.#redis = redis
    this.#prefix = prefix
  }

  async create(record: SeriesTokenRecord): Promise<void> {
    const key = this.#series(record.series)

    await this.#redis
      .multi()
      .hSet(key, {
        series: record.series,
        subject: record.subject,
        tokenHash: record.tokenHash,
        expiresAt: String(record.expiresAt),
        createdAt: String(record.createdAt),
      })
      .expireAt(key, record.expiresAt)
      .sAdd(this.#subject(record.subject), record.series)
      .exec()
  }

  async findBySeries(series: string): Promise<SeriesTokenRecord | null> {
    const stored = await this.#redis.hGetAll(this.#series(series))
    if (stored.series === undefined) {
      return null
    }

    return {
      series: stored.series,
      subject: stored.subject,
      tokenHash: stored.tokenHash,
      expiresAt: Number(stored.expiresAt),
      createdAt: Number(stored.createdAt),
      previousTokenHash: stored.previousTokenHash,
      rotatedAt: stored.rotatedAt === undefined ? undefined : Number(stored.rotatedAt),
    }
  }

  async rotate(series: string, expectedTokenHash: string, rotation: SeriesTokenRotation): Promise<boolean> {
    const swapped = await this.#redis.eval(ROTATE, {
      keys: [this.#series(series)],
      arguments: [expectedTokenHash, rotation.tokenHash, String(rotation.rotatedAt), String(rotation.expiresAt)],
    })

    return swapped === 1
  }

  async remove(series: string): Promise<void> {
    await this.#redis.del(this.#series(series))
  }

  async removeBySubject(subject: string): Promise<void> {
    const index = this.#subject(subject)
    const all = await this.#redis.sMembers(index)

    await this.#redis.del([index, ...all.map(series => this.#series(series))])
  }

  #series(series: string): string {
    return `${this.#prefix}:series:${series}`
  }

  #subject(subject: string): string {
    return `${this.#prefix}:subject:${subject}`
  }
}

// One implementation behind both: the two base classes exist so an application can bind a store for each, and a
// class extends only one of them.

export class RedisRememberMeTokenStore extends RememberMeTokenStore {
  readonly #tokens: RedisSeriesTokens

  constructor(redis: RedisClient, prefix: string) {
    super()
    this.#tokens = new RedisSeriesTokens(redis, `${prefix}:remember`)
  }

  create = (record: SeriesTokenRecord) => this.#tokens.create(record)
  findBySeries = (series: string) => this.#tokens.findBySeries(series)
  rotate = (series: string, expected: string, rotation: SeriesTokenRotation) =>
    this.#tokens.rotate(series, expected, rotation)
  remove = (series: string) => this.#tokens.remove(series)
  removeBySubject = (subject: string) => this.#tokens.removeBySubject(subject)
}

export class RedisRefreshTokenStore extends RefreshTokenStore {
  readonly #tokens: RedisSeriesTokens

  constructor(redis: RedisClient, prefix: string) {
    super()
    this.#tokens = new RedisSeriesTokens(redis, `${prefix}:refresh`)
  }

  create = (record: SeriesTokenRecord) => this.#tokens.create(record)
  findBySeries = (series: string) => this.#tokens.findBySeries(series)
  rotate = (series: string, expected: string, rotation: SeriesTokenRotation) =>
    this.#tokens.rotate(series, expected, rotation)
  remove = (series: string) => this.#tokens.remove(series)
  removeBySubject = (subject: string) => this.#tokens.removeBySubject(subject)
}
