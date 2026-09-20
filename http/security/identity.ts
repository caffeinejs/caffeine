import type { Context } from '../context.js'

export class Identity {
  readonly #authenticationType: string
  readonly #authenticated: boolean
  readonly #roleClaimType: string

  #claims: Claim[]

  constructor(
    authenticationType: string,
    authenticated: boolean,
    claims: Claim[] = [],
    roleClaimType: string = 'roles',
  ) {
    this.#authenticationType = authenticationType
    this.#authenticated = authenticated
    // Copied, not aliased: `claims` advertises `readonly Claim[]`, and holding the caller's array would
    // make that a lie — whoever passed it in could keep appending to a principal already handed to
    // authorization. The reverse leaks too: `addClaim` would mutate an array the caller still holds.
    this.#claims = [...claims]
    this.#roleClaimType = roleClaimType
  }

  get authenticationType(): string {
    return this.#authenticationType
  }

  get authenticated(): boolean {
    return this.#authenticated
  }

  get claims(): readonly Claim[] {
    return this.#claims
  }

  get roleClaimType(): string {
    return this.#roleClaimType
  }

  addClaim(claim: Claim): void {
    this.#claims.push(claim)
  }

  /** Drops every claim the predicate matches. */
  removeClaimBy(predicate: (claim: Claim) => boolean): void {
    this.#claims = this.#claims.filter(claim => !predicate(claim))
  }
}

export class Claim {
  constructor(
    readonly type: string,
    readonly value: unknown,
    readonly issuer: string,
  ) {}
}

export type PrincipalMapper = (ctx: Context, principal: Principal) => Promise<Principal> | Principal

export class Principal {
  readonly #authenticated: boolean
  readonly #identities: Identity[]

  constructor(authenticated: boolean, identities: Identity[] | Identity) {
    this.#authenticated = authenticated
    this.#identities = Array.isArray(identities) ? identities : [identities]
  }

  get authenticated(): boolean {
    return this.#authenticated
  }

  get identities(): readonly Identity[] {
    return this.#identities
  }

  findFirst(type: string): Claim | undefined {
    return this.#identities.find(i => i.claims.some(c => c.type === type))?.claims.find(c => c.type === type)
  }

  findAll(type: string): readonly Claim[] {
    return this.#identities.flatMap(i => i.claims.filter(c => c.type === type))
  }

  /**
   * Whether any identity holds a claim of `type` — and, given a `value`, one whose value is it.
   *
   * A claim whose value is a list holds each of its members: a token carries `groups: ['eng', 'on-call']` as one
   * claim, and `hasClaim('groups', 'on-call')` is true of it.
   */
  hasClaim(type: string, value?: unknown): boolean {
    return this.#identities.some(i => i.claims.some(c => c.type === type && (value === undefined || holds(c, value))))
  }

  isInRole(role: string): boolean {
    return this.#identities.some(i => i.claims.some(c => c.type === i.roleClaimType && holds(c, role)))
  }

  claims(type?: string): readonly Claim[] {
    if (type === undefined) {
      return this.#identities.flatMap(i => i.claims)
    }

    return this.#identities.flatMap(i => i.claims.filter(c => c.type === type))
  }

  addIdentity(identity: Identity): void {
    this.#identities.push(identity)
  }
}

function holds(claim: Claim, value: unknown): boolean {
  return Array.isArray(claim.value) ? claim.value.includes(value) : claim.value === value
}

/**
 * Folds a newly authenticated principal into whatever a route has accumulated so far.
 *
 * A route naming several schemes authenticates against every one of them, and each that succeeds
 * contributes its identities to a single principal — so a policy can require a claim asserted by one
 * scheme and a role asserted by another. Taking only the first success instead would make the outcome
 * depend on declaration order and put the two identities permanently out of reach of each other.
 *
 * The first principal is the one that survives as the container, and identities are appended in the order
 * their schemes were named, so `findFirst` resolves ties towards the earlier scheme.
 */
export function mergePrincipals(into: Principal | undefined, from: Principal): Principal {
  if (into === undefined) {
    return from
  }

  const merged = new Principal(true, [...into.identities])
  for (const identity of from.identities) {
    merged.addIdentity(identity)
  }

  return merged
}

class AnonymousUser extends Principal {
  constructor() {
    super(false, [])
  }

  addIdentity(): void {
    throw new Error('Anonymous user cannot add identities')
  }
}

/**
 * A fresh unauthenticated principal.
 *
 * A new instance per call rather than a shared singleton. `AnonymousUser.addIdentity` throws, so one
 * instance is safe today, but it would be a single mutable object standing in for every unauthenticated
 * request in the process — and the safety rests entirely on that one override staying in place.
 * Allocating an empty object on a path that is already doing I/O is not a cost worth that coupling.
 */
export function newAnonymousUser(): Principal {
  return new AnonymousUser()
}
