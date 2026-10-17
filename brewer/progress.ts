/**
 * A stream that passes every chunk through as it is and reports how many bytes have gone through it so far.
 *
 * `fetch` reports no progress of its own; this is the standard way to have it. Pipe a download through it and read
 * the result, its total in `Content-Length`:
 *
 * ```ts
 * const res = await client.reports({ id }).get()
 * const total = Number(res.headers.get('content-length'))
 * const counted = res.body!.pipeThrough(progress(loaded => bar.update(loaded / total)))
 * ```
 *
 * Or send an upload through it as a stream, its total in `file.size`:
 * `body: file.stream().pipeThrough(progress(loaded => bar.update(loaded / file.size)))`. A streamed upload is counted
 * as `fetch` reads it. Browsers send one only over HTTP/2, and Firefox and Safari not at all; Node sends one always.
 *
 * A `Content-Length` counts the bytes on the wire, so it is no total for a body the server compressed, which `fetch`
 * hands over decompressed.
 */
export function progress(onProgress: (loaded: number) => void): TransformStream<Uint8Array, Uint8Array> {
  let loaded = 0

  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk)
      loaded += chunk.byteLength
      onProgress(loaded)
    },
  })
}
