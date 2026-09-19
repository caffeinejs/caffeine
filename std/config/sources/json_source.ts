import { FileConfigSource, type FileConfigSourceOptions } from './file_source.js'

/**
 * Configuration from a JSON file. The one format `std` parses itself, because the runtime carries the parser.
 * Anything else, YAML, TOML or JSON5, is a {@link FileConfigSource} handed the parse function of whichever library
 * the application already depends on.
 */
export class JSONConfigSource extends FileConfigSource {
  constructor(path: string, options: FileConfigSourceOptions = {}) {
    super(path, text => JSON.parse(text) as Record<string, unknown>, options)
  }
}
