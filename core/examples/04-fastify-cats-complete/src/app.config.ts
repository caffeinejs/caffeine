import { Injectable } from '@caffeinejs/core/decorators'

@Injectable()
export class AppConfig {
  readonly databaseUrl = process.env['DATABASE_URL'] ?? 'postgresql://cats:cats@localhost:5432/cats'
  readonly redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379'
  readonly port = Number(process.env['PORT'] ?? 3000)
  readonly gcsEndpoint = process.env['GCS_ENDPOINT'] ?? 'http://localhost:4443'
  readonly gcsBucket = process.env['GCS_BUCKET'] ?? 'cats'
  readonly gcsObject = process.env['GCS_OBJECT'] ?? 'data.config.json'
  readonly gcsPollIntervalMs = Number(process.env['GCS_POLL_INTERVAL_MS'] ?? 5000)
  readonly gcsProjectId = process.env['GCS_PROJECT_ID'] ?? 'cats-local'
}
