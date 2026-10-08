import { CaffeineIoC } from '@caffeinejs/di'

// Decorated components must be loaded at least once for the decorators to be evaluated.
// Nothing else imports these modules, so they are loaded here.
import './cats/cats.pg.repository.js'
import './health/cache.health.js'
import './health/db.health.js'
import './util/cache/cache.config.js'
import './util/db/database.config.js'
import './util/gcs/gcs.config.js'
import './util/gcs/gcs.watcher.js'
import { healthModule } from './health/health.mod.js'

export async function createContainer(): Promise<CaffeineIoC> {
  // The health components are configured "manually" using a Module function.
  // All the other decorated components are registered once their modules are loaded.
  // Both concepts can be mixed.
  return new CaffeineIoC({ modules: [healthModule] })
}
