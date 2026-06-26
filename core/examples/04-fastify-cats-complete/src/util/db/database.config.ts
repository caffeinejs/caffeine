import { Pool } from 'pg'
import { Configuration, OnPreDestroy, Provides } from '@caffeinejs/core'
import { AppConfig } from '../../app.config.js'
import { kPgPool } from '../../keys.js'

@Configuration([AppConfig])
export class DatabaseConfig {
  constructor(private readonly config: AppConfig) { }

  @Provides(kPgPool)
  @OnPreDestroy((pool: Pool) => pool.end())
  pgPool(): Pool {
    return new Pool({
      connectionString: this.config.databaseUrl, onConnect: () => {
        console.log('Connected to database')
      },
    })
  }
}
