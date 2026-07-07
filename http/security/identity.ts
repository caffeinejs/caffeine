import { Claim } from './claim.js'

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
    this.#claims = claims
    this.#roleClaimType = roleClaimType
  }

  get authenticationType(): string { return this.#authenticationType }
  get authenticated(): boolean { return this.#authenticated }
  get claims(): readonly Claim[] { return this.#claims }
  get roleClaimType(): string { return this.#roleClaimType }

  addClaim(claim: Claim): void {
    this.#claims.push(claim)
  }

  removeClaimBy(predicate: (claim: Claim) => boolean): void {
    this.#claims = this.#claims.filter(predicate)
  }
}
