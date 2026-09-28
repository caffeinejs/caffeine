/**
 * The headers of a {@link FetchyRequest}. Names are case-insensitive, as they are in {@link Headers}.
 *
 * Names are stored lowercased, so an interceptor that sets `Authorization` replaces an `authorization` the
 * declaration set instead of sending the header twice.
 */
export class FetchyHeaders implements Iterable<[string, string]> {
  readonly #record: Record<string, string> = {}

  constructor(init?: Readonly<Record<string, string>>) {
    if (init) {
      for (const name in init) {
        this.#record[name.toLowerCase()] = init[name]
      }
    }
  }

  /**
   * The headers as a plain object with lowercased names, which is the shape a transport sends.
   */
  get record(): Readonly<Record<string, string>> {
    return this.#record
  }

  get(name: string): string | null {
    const key = name.toLowerCase()
    return Object.hasOwn(this.#record, key) ? this.#record[key] : null
  }

  has(name: string): boolean {
    return Object.hasOwn(this.#record, name.toLowerCase())
  }

  set(name: string, value: string): void {
    this.#record[name.toLowerCase()] = value
  }

  /**
   * Adds a value, joining it to an existing one with `", "` as {@link Headers.append} does.
   */
  append(name: string, value: string): void {
    const key = name.toLowerCase()
    this.#record[key] = Object.hasOwn(this.#record, key) ? `${this.#record[key]}, ${value}` : value
  }

  delete(name: string): void {
    delete this.#record[name.toLowerCase()]
  }

  entries(): IterableIterator<[string, string]> {
    return Object.entries(this.#record)[Symbol.iterator]()
  }

  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries()
  }
}
