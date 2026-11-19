import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ErrStaticManifest, MANIFEST_FILE, parseManifest, REBUILD_SOLUTIONS, type StaticManifest } from './manifest.js'

/**
 * Reads and checks `<root>/static.manifest.json`: its JSON, its `version` and the shape of every entry. It touches no
 * other file: whether the files it lists exist is the server's check.
 *
 * @throws {@link ErrStaticManifest} naming what is wrong, and the field when it is the shape
 */
export async function readManifest(root: string): Promise<StaticManifest> {
  let text: string

  try {
    text = await readFile(join(root, MANIFEST_FILE), 'utf8')
  } catch (err) {
    const detail =
      (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? `${MANIFEST_FILE} is missing`
        : `${MANIFEST_FILE} cannot be read`
    throw new ErrStaticManifest(root, detail, ...REBUILD_SOLUTIONS)
  }

  return parseManifest(text, root)
}
