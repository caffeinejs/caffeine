import { FileConfigProvider } from './file_provider.js'

/**
 * Reads configuration from a JSON file.
 *
 * The one format `std` parses itself, because the runtime already carries the parser. Anything else — YAML,
 * TOML, JSON5 — is a {@link FileConfigProvider} handed the application's own parse function, and that includes
 * replacing this one: `new FileConfigProvider('./app.json', text => JSON5.parse(text))`.
 *
 * Active profiles load `{stem}-{profile}.json` siblings of the given path, same rule as {@link FileConfigProvider}.
 */
export class JSONConfigProvider extends FileConfigProvider {
  constructor(filePath: string) {
    super(filePath, text => JSON.parse(text) as Record<string, unknown>)
  }
}
