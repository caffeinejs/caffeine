import { accessSync, constants } from 'node:fs'

/**
 * Loads dotenv files into `process.env` with `process.loadEnvFile`, for `.dotEnv()` on a configuration:
 *
 * ```ts
 * newConfiguration(schema, kConfig).dotEnv({ loader: loadEnvFiles, path: './config' })
 * ```
 *
 * The first file to set a variable wins, and a variable already set wins over every file. Values are taken as
 * written: this loader expands nothing, and a placeholder such as `${env:NAME}` is the configuration's to fill in.
 *
 * A file that is not there is skipped. One that is there and cannot be read fails the load, and so does a path
 * that names a file where a directory should be.
 */
export function loadEnvFiles(filenames: readonly string[]): void {
  for (const filename of filenames) {
    try {
      // `process.loadEnvFile` reports a file it may not read as missing: only this tells the two apart.
      accessSync(filename, constants.R_OK)
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        continue
      }
      throw error
    }

    process.loadEnvFile(filename)
  }
}
