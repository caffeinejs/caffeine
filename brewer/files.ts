import type { FormDataOf, FormFields } from './form.js'

/**
 * What a client offers beside its routes for files: reading a download, counting the bytes of a stream, and building
 * an upload.
 *
 * Answered at the root only, `$`-prefixed like `$request`, so a route segment is unlikely to share a name with one.
 * A root segment that does is reached through `$request`; deeper down, the name is a segment like any other.
 */
export interface FileHelpers {
  /**
   * A download as a `File`: its bytes, under the name {@link FileHelpers.$filename} reads, typed by `Content-Type`
   * and dated by `Last-Modified`.
   *
   * A download that names itself nowhere is named after the last segment of its URL, as a browser names it, and
   * otherwise `fallback`. The whole body is read into memory: a download too large to hold is read from `body`
   * instead, and named with {@link FileHelpers.$filename}.
   */
  $file(response: Pick<Response, 'headers' | 'url' | 'blob'>, fallback?: string): Promise<File>

  /**
   * The name a download gives itself in its `Content-Disposition`, or `undefined` when it gives none a file could be
   * saved under.
   *
   * The UTF-8 `filename*` of RFC 8187 wins over the plain `filename`, as browsers read it. The name is reduced to its
   * last segment, with control characters dropped, so a name the server chose can never point outside where the
   * caller saves it: `../../.ssh/authorized_keys` names `authorized_keys`.
   *
   * Reads only the headers, so a download streamed straight from `body` can be named before any of it is read.
   */
  $filename(response: Pick<Response, 'headers'>): string | undefined

  /**
   * A stream that passes every chunk through as it is and reports how many bytes have gone through it so far.
   *
   * `fetch` reports no progress of its own; this is the standard way to have it. Pipe a download through it and read
   * the result, its total in `Content-Length`:
   *
   * ```ts
   * const res = await client.reports({ id }).get()
   * const total = Number(res.headers.get('content-length'))
   * const counted = res.body!.pipeThrough(client.$progress(loaded => bar.update(loaded / total)))
   * ```
   *
   * Or send an upload through it as a stream, its total in `file.size`:
   * `body: file.stream().pipeThrough(client.$progress(loaded => bar.update(loaded / file.size)))`. A streamed upload
   * is counted as `fetch` reads it. Browsers send one only over HTTP/2, and Firefox and Safari not at all; Node sends
   * one always.
   *
   * A `Content-Length` counts the bytes on the wire, so it is no total for a body the server compressed, which `fetch`
   * hands over decompressed.
   */
  $progress(onProgress: (loaded: number) => void): TransformStream<Uint8Array, Uint8Array>

  /**
   * A multipart form built from an object, its fields checked against the route it is sent to.
   *
   * An upload route takes a `FormData`, whose parts nothing checks, here or on a server that leaves an upload
   * unvalidated. A form built this way remembers its fields, and the call refuses one with a field missing or of the
   * wrong type:
   *
   * ```ts
   * await client.pets.photos.post({ body: client.$formData({ caption: 'Rex', photo: file }) })
   * ```
   *
   * A list sends each of its items under the field's name, a number or a boolean goes as the text the server reads
   * back, and a field given `undefined` or `null` is left out. A plain `FormData` is still taken, unchecked.
   */
  $formData<T extends FormFields>(values: T): FormDataOf<T>
}
