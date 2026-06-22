import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { Storage } from '@google-cloud/storage'

export type WorkerData = {
  endpoint: string
  bucket: string
  object: string
  pollIntervalMs: number
  projectId: string
}

export type WorkerMessage
  = | { type: 'config:available', generation: string }
    | { type: 'error', message: string }

if (!isMainThread && parentPort) {
  const port = parentPort
  const { endpoint, bucket, object, pollIntervalMs, projectId } = workerData as WorkerData

  const storage = new Storage({
    apiEndpoint: endpoint,
    projectId,
  })

  let lastGeneration: string | undefined

  async function poll(): Promise<void> {
    try {
      const file = storage.bucket(bucket).file(object)
      const [exists] = await file.exists()
      if (!exists) {
        return
      }

      const [metadata] = await file.getMetadata()
      const generation = String(metadata.generation ?? '')
      if (generation === lastGeneration) {
        return
      }

      lastGeneration = generation
      port.postMessage({ type: 'config:available', generation } satisfies WorkerMessage)
    } catch (err) {
      port.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      } satisfies WorkerMessage)
    }
  }

  setInterval(() => {
    void poll()
  }, pollIntervalMs)

  void poll()
}
