export class DataConfig {
  constructor(
    readonly data: Record<string, unknown>,
    readonly loadedAt = new Date(),
  ) {
    console.log('DataConfig constructor', this.data)
  }
}
