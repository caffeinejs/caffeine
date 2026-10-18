/**
 * A File of another implementation, as formdata-node's is: no instance of the global Blob, with the tag and the members
 * of a File.
 */
export class OtherFile {
  readonly type = 'application/pdf'
  readonly size = 8

  constructor(readonly name: string) {}

  get [Symbol.toStringTag](): string {
    return 'File'
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(new TextEncoder().encode('%PDF-1.7').buffer)
  }
}

/**
 * A FormData of another implementation, as undici's is to Node's global one: no instance of the global class, with the
 * tag, the methods and the entries of a FormData. An entry is kept as it was given, whatever it is.
 */
export class OtherFormData {
  #entries: [string, unknown][] = []

  get [Symbol.toStringTag](): string {
    return 'FormData'
  }

  append(name: string, value: unknown): void {
    this.#entries.push([name, value])
  }

  delete(name: string): void {
    this.#entries = this.#entries.filter(([entry]) => entry !== name)
  }

  get(name: string): unknown {
    return this.#entries.find(([entry]) => entry === name)?.[1] ?? null
  }

  getAll(name: string): unknown[] {
    return this.#entries.filter(([entry]) => entry === name).map(([, value]) => value)
  }

  has(name: string): boolean {
    return this.#entries.some(([entry]) => entry === name)
  }

  set(name: string, value: unknown): void {
    this.delete(name)
    this.append(name, value)
  }

  [Symbol.iterator](): IterableIterator<[string, unknown]> {
    return this.#entries[Symbol.iterator]()
  }
}
