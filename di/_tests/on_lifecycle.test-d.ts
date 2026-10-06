import { Configuration } from '../decorators/configuration.js'
import { OnLifecycle } from '../decorators/on_lifecycle.js'
import { Provides } from '../decorators/provides.js'
import { ProvidesAsync } from '../decorators/provides_async.js'

/**
 * `@OnLifecycle` types the instance its callbacks receive from the method it decorates, so a call site needs no
 * type argument and a callback written for another bean does not compile. Nothing at run time can fail when that
 * inference drifts, so this file is what holds it: `npm run test:typecheck` is the test.
 */

declare class DbConnection {
  open(): void
  close(): void
}

declare class DataSource {
  destroy(): Promise<void>
}

declare class Other {
  other(): void
}

declare function connect(): Promise<DataSource>
declare function connectSync(): DbConnection

@Configuration()
class AppConfig {
  // No type argument: the callbacks receive what the method returns. Before the inference, `c` was `unknown`.
  @OnLifecycle({ bootstrap: c => c.open(), destroy: c => c.close() })
  @Provides(DbConnection)
  connection(): DbConnection {
    return connectSync()
  }

  // The container awaits an asynchronous factory and hands the callbacks the resolved instance, never the
  // promise: `Promise` has no `destroy`.
  @OnLifecycle({ destroy: ds => ds.destroy() })
  @ProvidesAsync(DataSource)
  dataSource(): Promise<DataSource> {
    return connect()
  }

  // Call sites written before the inference keep compiling: a type argument names the resolved instance.
  @OnLifecycle<DataSource>({ destroy: ds => ds.destroy() })
  @ProvidesAsync(DataSource)
  async explicit(): Promise<DataSource> {
    return connect()
  }

  // @ts-expect-error a type argument naming another bean is checked against the method
  @OnLifecycle<Other>({ destroy: o => o.other() })
  @Provides(DbConnection)
  wrongTypeArgument(): DbConnection {
    return connectSync()
  }

  // A callback written for another bean. This one also fails if the instance type ever widens to `any`.
  // @ts-expect-error the callback does not accept the bean the method produces
  @OnLifecycle({ destroy: (o: Other) => o.other() })
  @Provides(DbConnection)
  wrongCallback(): DbConnection {
    return connectSync()
  }

  // The type argument keeps the callback valid, so the only error left is the decorated member.
  // @ts-expect-error only a method produces a bean; a getter used to fail at run time alone
  @OnLifecycle<DbConnection>({ destroy: c => c.close() })
  get getter(): DbConnection {
    return connectSync()
  }
}

void AppConfig
