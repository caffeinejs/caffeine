import type { ConfigEntry, ConfigProvider, ConfigValue, PropertySource, ResolutionContext } from '../config.js'
import { flattenObject } from '../flatten.js'

export class InlineConfigProvider implements ConfigProvider {
  readonly id: string
  readonly #data: Record<string, ConfigValue>

  constructor(data: Record<string, ConfigValue>, id = 'inline') {
    this.#data = data
    this.id = id
  }

  async load(_ctx: ResolutionContext): Promise<PropertySource[]> {
    const entries = new Map<string, ConfigEntry>()
    flattenObject(this.#data, `inline:${this.id}`, '', entries)
    return [{ name: `inline:${this.id}`, entries }]
  }
}
