import { createHash, randomBytes } from 'node:crypto'

import {
  Claim,
  Identity,
  OpaqueTokenStore,
  Principal,
  type RemoteAuthenticationTicket,
  type RemoteAuthenticationTicketStore,
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
