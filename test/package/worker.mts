import { verifyStaticAssets, type StaticAssetSource, type VerifyStaticAssetsOptions } from '@caffeinejs/static/web'

interface Release {
  readonly manifest: Uint8Array
  readonly objects: Map<string, Uint8Array>
  readonly keys: string[]
  readonly limits?: Pick<VerifyStaticAssetsOptions, 'maxManifestSize' | 'maxEntries'>
}

function body(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) {
        controller.close()
        return
      }
      const end = Math.min(offset + 3, bytes.length)
      controller.enqueue(bytes.subarray(offset, end))
      offset = end
    },
  })
}

self.onmessage = async ({ data }: MessageEvent<Release>) => {
  const opened: string[] = []
  const source: StaticAssetSource = {
    readManifest: async () => body(data.manifest),
    async open(key) {
      opened.push(key)
      const bytes = data.objects.get(key)
      if (!bytes) {
        throw new Error(`Missing "${key}"`)
      }
      return body(bytes)
    },
  }
  try {
    const assets = await verifyStaticAssets(source, data.limits)
    self.postMessage({
      files: assets.files,
      bytes: assets.bytes,
      variants: assets.variants,
      membership: data.keys.map(key => assets.has(key)),
      opened,
      globals: ['process', 'require', 'Buffer'].filter(key => key in globalThis),
      host: self.constructor.name,
    })
  } catch (err) {
    self.postMessage({ error: err instanceof Error ? err.message : String(err), opened })
  }
}
