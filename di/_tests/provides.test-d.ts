import { Configuration } from '../decorators/configuration.js'
import { Provides } from '../decorators/provides.js'
import { ProvidesAsync } from '../decorators/provides_async.js'

/**
 * The whole point of splitting `@Provides` from `@ProvidesAsync` is that the container can no longer be handed
 * a factory it would cache unresolved. Nothing at run time can fail when these overloads drift, so this file
 * is what holds them: `npm run test:typecheck` is the test.
 */

declare class DataSource {
  query(): void
}

declare function connect(): Promise<DataSource>
declare function connectSync(): DataSource

@Configuration()
class AppConfig {
  // The reported defect: an `async` factory on the synchronous decorator. Dependants used to receive the
  // pending promise, and only found out on first use.
  // @ts-expect-error an asynchronous factory is declared with @ProvidesAsync
  @Provides(DataSource)
  async reported(): Promise<DataSource> {
    return connect()
  }

  // The same mistake without the `async` keyword. This one is why the check is in the type system rather than
  // a run-time look at the method: it is not an AsyncFunction, so nothing could have spotted it by inspection.
  // @ts-expect-error a promise-returning factory is declared with @ProvidesAsync
  @Provides(DataSource)
  sneaky(): Promise<DataSource> {
    return connect()
  }

  @ProvidesAsync(DataSource)
  async correct(): Promise<DataSource> {
    return connect()
  }

  @Provides(DataSource)
  ordinary(): DataSource {
    return connectSync()
  }
}

void AppConfig
