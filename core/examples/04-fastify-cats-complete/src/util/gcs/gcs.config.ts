import { Storage } from '@google-cloud/storage'
import { Async, Configuration, Lifetime, Provides, Scopes } from '@caffeinejs/core'
import { AppConfig } from '../../app.config.js'
import { DataConfig } from './data.config.js'

@Configuration([AppConfig])
export class GcsConfig {
  constructor(private readonly config: AppConfig) {}

  @Provides(Storage)
  storage(): Storage {
    return new Storage({
      apiEndpoint: this.config.gcsEndpoint,
      projectId: this.config.gcsProjectId,
    })
  }

  @Async()
  @Lifetime(Scopes.REFRESH)
  @Provides(DataConfig, [Storage, AppConfig])
  async dataConfig(storage: Storage, config: AppConfig): Promise<DataConfig> {
    const file = storage.bucket(config.gcsBucket).file(config.gcsObject)
    const [exists] = await file.exists()
    if (!exists) {
      return new DataConfig({})
    }

    const [content] = await file.download()

    return new DataConfig(JSON.parse(content.toString()) as Record<string, unknown>)
  }
}
