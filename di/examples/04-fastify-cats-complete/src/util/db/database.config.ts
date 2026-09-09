import { Configuration, OnLifecycle, Provides } from '@caffeinejs/di'
import { Pool } from 'pg'

import { AppConfig } from '../../app.config.js'
import { kPgPool } from '../../keys.js'

@Configuration([AppConfig])
export class DatabaseConfig {
  constructor(private readonly config: AppConfig) {}

  @Provides(kPgPool)
  @OnLifecycle<Pool>({ destroy: pool => pool.end() })
  pgPool(): Pool {
    return new Pool({
      connectionString: this.config.databaseURL,
      onConnect: () => {
        console.log('Connected to database')
      },
    })
  }
}
