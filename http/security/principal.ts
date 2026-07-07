import type { Context } from '../context.js'
import { Claim } from './claim.js'
import { Identity } from './identity.js'

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
    return this.#identities
      .find(i => i.claims.some(c => c.type === type))?.claims.find(c => c.type === type)
  }

  findAll(type: string): readonly Claim[] {
    return this.#identities.flatMap(i => i.claims.filter(c => c.type === type))
  }

  hasClaim(type: string, value?: unknown): boolean {
    return this.#identities.some(i => i.claims.some(c => c.type === type && (value === undefined || c.value === value)))
  }

  isInRole(role: string): boolean {
    return this.#identities
      .some(i => i.claims.some(c => c.type === i.roleClaimType
        && (Array.isArray(c.value) ? c.value.includes(role) : c.value === role)))
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

class AnonymousUser extends Principal {
  constructor() {
    super(false, [])
  }

  addIdentity(): void {
    throw new Error('Anonymous user cannot add identities')
  }
}

const ANONYMOUS_USER = new AnonymousUser()

export function newAnonymousUser(): Principal {
  return ANONYMOUS_USER
}
