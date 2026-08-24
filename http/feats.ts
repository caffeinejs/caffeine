// Feats holds feature flags for the application
// Services can check the flags and toggle them as needed.
export class Feats {
  #authentication = false
  #health = false

  get authentication(): boolean {
    return this.#authentication
  }

  toggleAuthentication(value: boolean = true): this {
    this.#authentication = value
    return this
  }

  /** Whether the health feature was configured explicitly, as opposed to auto-detected from the environment. */
  get health(): boolean {
    return this.#health
  }

  toggleHealth(value: boolean = true): this {
    this.#health = value
    return this
  }
}
