// Feats holds feature flags for the application
// Services can check the flags and toggle them as needed.
export class Feats {
  #authentication = false

  get authentication(): boolean {
    return this.#authentication
  }

  toggleAuthentication(value: boolean = true): this {
    this.#authentication = value
    return this
  }
}
