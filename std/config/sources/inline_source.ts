import type { ConfigLayer, ConfigObject, ConfigSource } from '../types.js'

/** Configuration from a fixed object: embedded defaults, test fixtures. Loaded once, taken literally. */
export class InlineConfigSource implements ConfigSource {
  readonly name: string
  readonly #data: ConfigObject

  /** @param name - Defaults to `inline`. Two inline sources in one configuration need names of their own. */
  constructor(data: Record<string, unknown>, name = 'inline') {
    this.name = name
    this.#data = data as ConfigObject
  }

  load(): readonly ConfigLayer[] {
    return [{ name: this.name, data: this.#data }]
  }
}
