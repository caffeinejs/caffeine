import { Worker } from 'node:worker_threads'
import { Keys, type Provider, type Refresher } from '@caffeinejs/di'
import { $i, Injectable, PostConstruct, PreDestroy } from '@caffeinejs/di'
import { AppConfig } from '../../app.config.js'
import { DataConfig } from './data.config.js'
import { WorkerData, WorkerMessage } from './gcs.watcher.worker.js'

@Injectable([AppConfig, Keys.kRefresher, $i.provide(DataConfig)])
export class GcsWatcher {
  private worker?: Worker

  constructor(
    private readonly config: AppConfig,
    private readonly refresher: Refresher,
    private readonly dataConfig: Provider<DataConfig>,
  ) { }

  @PostConstruct()
  start(): void {
    if (this.worker) {
      return
    }

    console.log('Starting GCS watcher...')

    this.worker = new Worker(new URL('./gcs.watcher.worker.ts', import.meta.url), {
      execArgv: ['--import', 'tsx/esm'],
      workerData: {
        endpoint: this.config.gcsEndpoint,
        bucket: this.config.gcsBucket,
        object: this.config.gcsObject,
        pollIntervalMs: this.config.gcsPollIntervalMs,
        projectID: this.config.gcsProjectID,
      } as WorkerData,
    })

    this.worker.on('message', (msg: WorkerMessage) => {
      if (msg.type === 'error') {
        console.error(`GCS watcher error: ${msg.message}`)
        return
      }

      this.refresher.refresh()
        .then(() => {
          const config = this.dataConfig.get()
          if (config) {
            console.log(`DataConfig refreshed (generation=${msg.generation}, loadedAt=${config.loadedAt.toISOString()})`)
          } else {
            console.log(`DataConfig refreshed (generation=${msg.generation})`)
          }
        })
        .catch((err: Error) => {
          console.error(`GCS watcher error: ${err.message}`)
        })
    })

    this.worker.on('error', (err: Error) => {
      console.error(`GCS watcher thread error: ${err.message}`)
    })

    console.log('GCS watcher started')
  }

  @PreDestroy()
  async stop(): Promise<void> {
    await this.worker?.terminate()
    this.worker = undefined
  }
}
