import { constants, lstatSync, realpathSync, statSync } from 'node:fs'
import { open as openFile, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'

import { KiB } from '@caffeinejs/std/bytes'

import { ErrStaticManifest, isRelativePath, MANIFEST_FILE, nameProblem } from '../manifest/manifest.js'
import type { StaticAssetSource } from '../web/web.js'

const CHUNK_SIZE = 64 * KiB

/**
 * Binds a local release directory to its current real path. Keep the release tree immutable for the source's
 * lifetime. Each open reads the stored bytes, including compressed variants, from one checked file descriptor.
 *
 * @throws {@link ErrStaticManifest} if the root cannot be opened as a directory
 */
export function directorySource(root: string): StaticAssetSource {
  let directory: string

  try {
    directory = realpathSync.native(root)
    if (!statSync(directory).isDirectory()) {
      throw new ErrStaticManifest(root, 'the root is not a directory', 'Pass the directory containing the release')
    }
  } catch (err) {
    if (err instanceof ErrStaticManifest) {
      throw err
    }
    throw new ErrStaticManifest(root, 'the root cannot be read', 'Pass the directory containing the release')
  }

  const open: StaticAssetSource['open'] = async (key, { range, signal }) => {
    signal?.throwIfAborted()
    const problem = nameProblem(key, true)
    if (problem !== undefined || !isRelativePath(key)) {
      throw new ErrStaticManifest(
        root,
        problem ?? `"${key}" is not a relative path under the root`,
        'Use a release-relative storage key',
      )
    }

    const failure = (detail: string) =>
      new ErrStaticManifest(root, `"${key}" ${detail}`, 'Check the file in the staged release')
    let handle: FileHandle | undefined

    try {
      const parent = realpathSync.native(join(directory, dirname(key)))
      const fromRoot = relative(directory, parent)
      if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith('..' + sep)) {
        throw failure('resolves outside the root')
      }

      const file = join(parent, basename(key))
      // Where O_NOFOLLOW is unavailable, the immutable tree permits checking the final component before opening it.
      if (!constants.O_NOFOLLOW && !lstatSync(file).isFile()) {
        throw failure('is not a regular file')
      }
      // O_NONBLOCK keeps a FIFO from hanging the open before fstat can reject it.
      handle = await openFile(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const stats = await handle.stat()
      signal?.throwIfAborted()
      if (!stats.isFile()) {
        throw failure('is not a regular file')
      }

      const start = range === undefined ? 0 : range.start
      const end = range === undefined ? stats.size : range.endExclusive
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || end > stats.size) {
        throw failure(`has an invalid byte range [${start}, ${end}) for ${stats.size} bytes`)
      }

      return fileBytes(handle, start, end, signal, failure)
    } catch (err) {
      await handle?.close()
      signal?.throwIfAborted()
      if (err instanceof ErrStaticManifest) {
        throw err
      }
      throw failure('cannot be opened as a regular file')
    }
  }

  return { readManifest: signal => open(MANIFEST_FILE, { signal }), open }
}

function fileBytes(
  file: FileHandle,
  position: number,
  end: number,
  signal: AbortSignal | undefined,
  failure: (detail: string) => ErrStaticManifest,
): ReadableStream<Uint8Array> {
  let controller: ReadableStreamDefaultController<Uint8Array>
  let closing: Promise<void> | undefined

  function close(): Promise<void> {
    signal?.removeEventListener('abort', abort)
    return (closing ??= file.close())
  }

  function abort(): void {
    controller.error(signal!.reason)
    // Readers have already received the abort reason. FileHandle waits for any in-flight read before closing.
    void close().catch(() => undefined)
  }

  return new ReadableStream<Uint8Array>(
    {
      async start(output) {
        controller = output
        if (position === end) {
          await close()
          controller.close()
        } else {
          signal?.addEventListener('abort', abort, { once: true })
        }
      },
      async pull() {
        try {
          const chunk = new Uint8Array(Math.min(CHUNK_SIZE, end - position))
          const { bytesRead } = await file.read(chunk, 0, chunk.length, position)
          if (closing !== undefined) {
            return
          }
          if (bytesRead === 0) {
            throw failure('ended before its checked length')
          }
          position += bytesRead
          controller.enqueue(chunk.subarray(0, bytesRead))
          if (position === end) {
            await close()
            controller.close()
          }
        } catch (err) {
          await close()
          throw err
        }
      },
      cancel: close,
    },
    { highWaterMark: 0 },
  )
}
