import { load } from 'js-yaml'
import type { FormatParser } from './file_provider.js'
import { registerParser } from './file_provider.js'

const yamlParser: FormatParser = {
  extensions: ['.yaml', '.yml'],
  parse(text: string): Record<string, unknown> {
    const parsed = load(text)
    if (parsed === null || parsed === undefined) {
      return {}
    }
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('YAML config file must be a mapping at the top level')
    }
    return parsed as Record<string, unknown>
  },
}

registerParser(yamlParser)

export { yamlParser }
