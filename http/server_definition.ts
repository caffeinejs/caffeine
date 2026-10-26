import type {
  AdapterExtensionFactory,
  IAdapterTypes,
  HTTPSetupContext,
  ServerConfigurer,
  ServerCustomizer,
} from './adapter.js'
import { MiddlewarePipeline } from './core/middleware/pipeline.js'
import type { HTTPPlugin } from './plugin.js'

/** What `.basePath(...)` takes besides a string: resolved once at start-up, like a `.server(...)` configurer. */
export type BasePathConfigurer<C> = (context: HTTPSetupContext<C>) => string | undefined | Promise<string | undefined>

/**
 * What one server is built from: its settings, its plugins and its middleware. The application's own server and
 * every listener, `.listener(name, ...)`, are each one of these, built the same way; which routers a server serves
 * is decided by their binding alone.
 */
export class ServerDefinition<T extends IAdapterTypes = IAdapterTypes, C = unknown> {
  /** What its `.server(...)` calls return, in call order. */
  readonly server: ServerConfigurer<T, C>[] = []
  /** Its `.with(...)` factories, in call order. */
  readonly plugins: AdapterExtensionFactory<T['extension'] | HTTPPlugin<T>, C, T>[] = []
  /** What its `.use(...)` and `.useFn(...)` calls registered: resolved, and sealed, by its server's setup. */
  readonly middlewares = new MiddlewarePipeline<T['hook']>()
  /** Its `.serverCallback(...)` callbacks, in call order. */
  readonly customizers: ServerCustomizer<T, C>[] = []
  /** What its `.basePath(...)` set; the last call wins. */
  basePath: BasePathConfigurer<C> | undefined

  /** @param name - The name routers bind to; `undefined` for the application's own server. */
  constructor(readonly name?: string) {}
}
