import type { FileDecision } from '../response/index.js'
import type { AssetBody, StaticAssetSource } from './web.js'

// The built-in typed array getter recognizes byte views from any realm.
const typedArrayPrototype: object = Object.getPrototypeOf(Uint8Array.prototype)

/** Opens the exact selected interval and owns its reader until the response releases it. */
export async function openBody(
  source: StaticAssetSource,
  representation: NonNullable<FileDecision['representation']>,
  range: FileDecision['range'],
  signal: AbortSignal,
): Promise<AssetBody> {
  signal.throwIfAborted()
  const aborted = Promise.withResolvers<never>()
  const abortOpen = () => aborted.reject(signal.reason)
  signal.addEventListener('abort', abortOpen, { once: true })

  try {
    const opened = Promise.resolve()
      .then(() => {
        signal.throwIfAborted()
        return source.open(representation.path, { range, signal })
      })
      .then(async stream => {
        if (signal.aborted) {
          await stream.cancel(signal.reason).catch(() => undefined)
          throw signal.reason
        }

        const size = range === undefined ? representation.size : range.endExclusive - range.start
        return checkedBody(stream.getReader(), size, signal)
      })
    return await Promise.race([opened, aborted.promise])
  } finally {
    signal.removeEventListener('abort', abortOpen)
  }
}

function checkedBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  remaining: number,
  signal: AbortSignal,
): AssetBody {
  let controller: ReadableStreamDefaultController<Uint8Array>
  let closed = false
  let cancelled: Promise<void> | undefined

  function release(): void {
    closed = true
    signal.removeEventListener('abort', abort)
    reader.releaseLock()
  }

  function close(reason?: unknown): Promise<void> {
    if (closed) {
      return cancelled ?? Promise.resolve()
    }

    // Cancel the provider's reader even when a response hook has locked the outer stream.
    cancelled = reader.cancel(reason).catch(() => undefined)
    release()
    controller.error(reason)
    return cancelled
  }

  function abort(): void {
    void close(signal.reason)
  }

  const stream = new ReadableStream<Uint8Array>(
    {
      start(output) {
        controller = output
        signal.addEventListener('abort', abort, { once: true })
      },
      async pull() {
        try {
          const { value, done } = await reader.read()
          if (closed) {
            return
          }
          if (done) {
            if (remaining !== 0) {
              throw new Error('Static asset ended before its declared length')
            }
            release()
            controller.close()
            return
          }
          if (value.byteLength > remaining) {
            throw new Error('Static asset returned bytes outside its declared length')
          }
          const chunk: ArrayBufferView = value
          let bytes = value
          if (!(chunk instanceof Uint8Array)) {
            if (Reflect.get(typedArrayPrototype, Symbol.toStringTag, chunk) !== 'Uint8Array') {
              throw new Error('Static asset returned a chunk that is not a Uint8Array')
            }
            bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          }
          remaining -= bytes.byteLength
          controller.enqueue(bytes)
        } catch (err) {
          await close(err)
        }
      },
      cancel: close,
    },
    { highWaterMark: 0 },
  )

  return { stream, close }
}
