export class Claim {
  readonly #type: string
  readonly #value: unknown
  readonly #issuer: string

  constructor(type: string, value: unknown, issuer: string) {
    this.#type = type
    this.#value = value
    this.#issuer = issuer
  }

  get type(): string { return this.#type }
  get value(): unknown { return this.#value }
  get issuer(): string { return this.#issuer }
}
