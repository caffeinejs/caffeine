// The client's `$progress`, documented on `FileHelpers`: each chunk passed through, then the bytes so far reported.
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
