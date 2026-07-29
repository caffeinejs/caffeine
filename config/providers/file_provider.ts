import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { ConfigEntry, ConfigProvider, PropertySource, ResolutionContext } from '../types.js'
import { flattenObject } from './_flatten.js'

export interface FormatParser {
  readonly extensions: string[]
  parse(text: string): Record<string, unknown>
}

const parsers = new Map<string, FormatParser>()

const jsonParser: FormatParser = {
  extensions: ['.json'],
  parse: (text: string) => JSON.parse(text) as Record<string, unknown>,
}

registerParser(jsonParser)

export function registerParser(parser: FormatParser): void {
  for (const ext of parser.extensions) {
    parsers.set(ext.toLowerCase(), parser)
  }
}

export class FileProvider implements ConfigProvider {
  readonly id: string
  readonly #filePath: string

  constructor(filePath: string) {
    this.#filePath = filePath
    this.id = `file:${filePath}`
  }

  async load(_ctx: ResolutionContext): Promise<PropertySource[]> {
    const ext = extname(this.#filePath).toLowerCase()
    const parser = parsers.get(ext)

    if (!parser) {
      throw new Error(`Cannot load config file: no parser registered for extension "${ext}"`)
    }

    const text = await readFile(this.#filePath, 'utf8')
    const parsed = parser.parse(text)
    const entries = new Map<string, ConfigEntry>()

    flattenObject(parsed, `file:${this.#filePath}`, '', entries)

    return [{ name: `file:${this.#filePath}`, entries }]
  }
}
