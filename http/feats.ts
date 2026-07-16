// Feats holds feature flags for the application
// Services can check the flags and toggle them as needed.
export class Feats {
  #authentication = false
  #authorization = false

  get authentication(): boolean {
    return this.#authentication
  }

  toggleAuthentication(value: boolean = true): this {
    this.#authentication = value
    return this
  }

  get authorization(): boolean {
    return this.#authorization
  }

  toggleAuthorization(value: boolean = true): this {
    this.#authorization = value
    return this
  }
}
