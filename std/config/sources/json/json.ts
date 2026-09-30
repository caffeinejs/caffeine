import { FileConfigSource, type FileConfigSourceOptions } from '../file/index.js'

/**
 * Configuration from a JSON file. `std` parses JSON and YAML itself, the latter with `YAMLConfigSource`. Anything
 * else, TOML or JSON5, is a {@link FileConfigSource} handed the parse function of whichever library the application
 * already depends on.
 */
export class JSONConfigSource extends FileConfigSource {
  constructor(path: string, options: FileConfigSourceOptions = {}) {
    super(path, text => JSON.parse(text) as Record<string, unknown>, options)
  }
}
