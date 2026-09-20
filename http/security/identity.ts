import type { Context } from '../context.js'

/**
 * One set of claims about a caller, as one scheme established them.
 *
 * Immutable: {@link withClaims} and {@link withoutClaims} answer with another identity. A store may therefore hand
 * the same identity to every request that presents the same credential.
 */
export class Identity {
  readonly #authenticationType: string
  readonly #authenticated: boolean
  readonly #roleClaimType: string
  readonly #claims: readonly Claim[]

  constructor(
    authenticationType: string,
    authenticated: boolean,
    claims: Claim[] = [],
    roleClaimType: string = 'roles',
  ) {
    this.#authenticationType = authenticationType
    this.#authenticated = authenticated
    // Copied, not aliased: whoever passed the array in could otherwise keep appending to a principal already
    // handed to authorization.
    this.#claims = Object.freeze([...claims])
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

  /** This identity with `claims` added after the ones it holds. */
  withClaims(...claims: Claim[]): Identity {
    return this.#with([...this.#claims, ...claims])
  }

  /** This identity without the claims the predicate matches. */
  withoutClaims(predicate: (claim: Claim) => boolean): Identity {
    return this.#with(this.#claims.filter(claim => !predicate(claim)))
  }

  #with(claims: Claim[]): Identity {
    return new Identity(this.#authenticationType, this.#authenticated, claims, this.#roleClaimType)
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

/**
 * Who is asking: the identities every scheme that accepted the caller established.
 *
 * Immutable, as each {@link Identity} is: {@link withIdentity} answers with another principal.
 */
export class Principal {
  readonly #authenticated: boolean
  readonly #identities: readonly Identity[]

  constructor(authenticated: boolean, identities: readonly Identity[] | Identity) {
    this.#authenticated = authenticated
    this.#identities = Object.freeze(Array.isArray(identities) ? [...identities] : [identities as Identity])
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

  /** This principal with `identities` added after the ones it holds. */
  withIdentity(...identities: Identity[]): Principal {
    return new Principal(this.#authenticated, [...this.#identities, ...identities])
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

  return new Principal(true, [...into.identities, ...from.identities])
}

const ANONYMOUS = new Principal(false, [])

/** The unauthenticated principal: no identity, no claim. One instance stands for every such caller. */
export function anonymousUser(): Principal {
  return ANONYMOUS
}
