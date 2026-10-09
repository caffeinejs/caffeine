import { randomUUID } from 'node:crypto'

import { errors } from 'undici'

const encoder = new TextEncoder()
const CRLF = encoder.encode('\r\n')

// The escapes and line breaks of the HTML multipart/form-data encoding, as fetch and undici write them, so a server
// that takes their uploads takes these.
function escapeQuoted(value: string): string {
  return value.replace(/\n/g, '%0A').replace(/\r/g, '%0D').replace(/"/g, '%22')
}

function normalizeLineBreaks(value: string): string {
  return value.replace(/\r?\n|\r/g, '\r\n')
}

export interface FormDataBody {
  readonly contentType: string
  readonly length: number
  readonly body: AsyncIterable<Uint8Array>
}

// Reads a part only as fast as undici asks for it. Over HTTP/1.1, undici ends an aborted upload by returning from the
// body, which cancels the reader in `finally`. Over HTTP/2 it only stops asking, so the call's own signal cancels it,
// and the file a part reads from is let go of either way.
//
// The part is held to the size the length was counted from, since undici holds a body to its length only over HTTP/1.1
// with `strictContentLength` on. Past it, a server would read the rest as the next request, or end an HTTP/2
// connection and every request on it; short of it, a server would wait for bytes that never come.
async function* readPart(part: Blob, signal: AbortSignal | undefined): AsyncGenerator<Uint8Array> {
  const reader = part.stream().getReader()
  const cancel = (): void => {
    reader.cancel(signal?.reason).catch(() => undefined)
  }
  let unread = part.size

  signal?.addEventListener('abort', cancel, { once: true })

  try {
    for (;;) {
      const { done, value } = await reader.read()

      if (done) {
        if (unread !== 0) {
          throw new errors.RequestContentLengthMismatchError()
        }

        return
      }

      unread -= value.byteLength

      if (unread < 0) {
        throw new errors.RequestContentLengthMismatchError()
      }

      yield value
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => undefined)
  }
}

async function* streamParts(
  chunks: readonly (Uint8Array | Blob)[],
  signal: AbortSignal | undefined,
): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) {
    if (chunk instanceof Uint8Array) {
      yield chunk
    } else {
      yield* readPart(chunk, signal)
    }
  }
}

// Encodes a FormData of any implementation the way undici's own encoder does, apart from the boundary, but streams it:
// undici's encoder reads every part into memory before the first byte goes out.
export function encodeFormData(form: FormData, signal?: AbortSignal): FormDataBody {
  const boundary = `----fetchy-${randomUUID()}`
  const chunks: (Uint8Array | Blob)[] = []
  let length = 0

  // The entries are read now rather than as undici asks for them, so a part appended once the request is on its way
  // cannot make the body longer than the length it was sent with.
  for (const [name, value] of form) {
    const disposition = `--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuoted(normalizeLineBreaks(name))}"`

    if (typeof value === 'string') {
      const chunk = encoder.encode(`${disposition}\r\n\r\n${normalizeLineBreaks(value)}\r\n`)
      chunks.push(chunk)
      length += chunk.byteLength
      continue
    }

    // As undici's encoder does, a File named '' gets no filename, which makes it a text part.
    const filename = value.name ? `; filename="${escapeQuoted(value.name)}"` : ''
    const head = encoder.encode(
      `${disposition}${filename}\r\nContent-Type: ${value.type || 'application/octet-stream'}\r\n\r\n`,
    )

    chunks.push(head, value, CRLF)
    length += head.byteLength + value.size + CRLF.byteLength
  }

  const close = encoder.encode(`--${boundary}--\r\n`)
  chunks.push(close)
  length += close.byteLength

  return { contentType: `multipart/form-data; boundary=${boundary}`, length, body: streamParts(chunks, signal) }
}
