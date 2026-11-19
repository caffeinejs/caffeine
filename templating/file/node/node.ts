import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { KiB, type ByteSize } from '@caffeinejs/std/bytes'

import { ErrTemplateConfiguration, ErrTemplateLimit } from '../../errors.js'
import { assertTemplateFile, type TemplateSource } from '../../source.js'

/** Reads strict UTF-8 templates from ordered, private application-owned directories. */
export function fileTemplates(rootOrRoots: string | readonly string[]): TemplateSource {
  const configuredRoots = typeof rootOrRoots === 'string' ? [rootOrRoots] : [...rootOrRoots]
  if (configuredRoots.length === 0 || configuredRoots.some(root => typeof root !== 'string' || root.length === 0)) {
    throw configuration('Cannot read templates: provide at least one nonempty root directory')
  }
  const roots = configuredRoots.map(root => resolve(root))

  return {
    async load(logicalFile, maxSize, signal) {
      assertTemplateFile(logicalFile)
      if (!Number.isSafeInteger(maxSize) || maxSize < 0) {
        throw configuration('Cannot read templates: maxSize must be a nonnegative whole number of bytes')
      }
      signal.throwIfAborted()

      for (const root of roots) {
        let realRoot: string
        try {
          realRoot = await realpath(root)
          signal.throwIfAborted()
          if (!(await stat(realRoot)).isDirectory()) {
            throw configuration('Cannot read templates: a configured root is not a directory')
          }
        } catch (error) {
          signal.throwIfAborted()
          if (error instanceof ErrTemplateConfiguration) {
            throw error
          }
          throw configuration('Cannot read templates: a configured root directory cannot be resolved')
        }

        const candidate = resolve(realRoot, logicalFile)
        assertContained(realRoot, candidate, logicalFile)
        let realCandidate: string
        try {
          realCandidate = await realpath(candidate)
        } catch (error) {
          signal.throwIfAborted()
          if (missing(error)) {
            continue
          }
          throw configuration(`Cannot read template "${logicalFile}": the file cannot be resolved`)
        }
        assertContained(realRoot, realCandidate, logicalFile)
        signal.throwIfAborted()
        try {
          if (!(await stat(realCandidate)).isFile()) {
            throw configuration(`Cannot read template "${logicalFile}": the asset is not a regular file`)
          }
          signal.throwIfAborted()
          return await readTemplate(realCandidate, logicalFile, maxSize, signal)
        } catch (error) {
          signal.throwIfAborted()
          if (error instanceof ErrTemplateConfiguration || error instanceof ErrTemplateLimit) {
            throw error
          }
          throw configuration(`Cannot read template "${logicalFile}": the file cannot be read`)
        }
      }
      return undefined
    },
  }
}

async function readTemplate(path: string, name: string, maxSize: ByteSize, signal: AbortSignal): Promise<string> {
  const file = await open(path, 'r')
  try {
    signal.throwIfAborted()
    const info = await file.stat()
    if (!info.isFile()) {
      throw configuration(`Cannot read template "${name}": the asset is not a regular file`)
    }
    if (info.size > maxSize) {
      throw limit(name, maxSize)
    }

    const decoder = new TextDecoder('utf-8', { fatal: true })
    const buffer = new Uint8Array(Math.min(64 * KiB, maxSize + 1))
    let total = 0
    let source = ''
    for (;;) {
      signal.throwIfAborted()
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, maxSize - total + 1), null)
      signal.throwIfAborted()
      if (bytesRead === 0) {
        break
      }
      total += bytesRead
      if (total > maxSize) {
        throw limit(name, maxSize)
      }
      source += decoder.decode(buffer.subarray(0, bytesRead), { stream: true })
    }
    return source + decoder.decode()
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof TypeError) {
      throw configuration(`Cannot read template "${name}": the file is not valid UTF-8`)
    }
    throw error
  } finally {
    await file.close()
    signal.throwIfAborted()
  }
}

function assertContained(root: string, path: string, name: string): void {
  const child = relative(root, path)
  if (child === '' || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw configuration(`Cannot read template "${name}": the file is outside its configured root`)
  }
}

function missing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

function configuration(message: string): ErrTemplateConfiguration {
  return new ErrTemplateConfiguration(message)
}

function limit(name: string, maxSize: ByteSize): ErrTemplateLimit {
  return new ErrTemplateLimit(`Cannot read template "${name}": the file exceeds maxSize of ${maxSize} bytes`)
}
