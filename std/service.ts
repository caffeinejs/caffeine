import type { Container } from '@caffeinejs/di'
import type { ConfigDefinition } from './config/index.js'
import type { ApplicationAvailability } from './health/availability.js'

/**
 * What a {@link Service} may touch while declaring: the configuration definition, and nothing else.
 *
 * Deliberately narrow. There is no container here, so "a declare step registers configuration and binds
 * nothing" is enforced by the type rather than left to a comment — and a feature cannot accidentally depend
 * on a binding order that does not exist yet.
 */
export interface DeclareKit {
  /** The live configuration definition: where a feature writes its defaults and registers its slice. */
  config: ConfigDefinition
}

/**
 * The runtime kit handed to a {@link Service} when the application configures it, after configuration has
 * resolved and before the container is initialized. The base kit exposes the {@link Container} and the
 * application's {@link ApplicationAvailability}; concrete applications may extend it with platform-specific
 * handles (e.g. the HTTP app adds feature flags).
 */
export interface ServiceKit extends DeclareKit {
  container: Container
  /**
   * The application's availability. Bind this instance rather than letting the container construct one — the
   * lifecycle writes to the application's, and a second instance would report a state nothing ever updates.
   */
  availability: ApplicationAvailability
}

/**
 * Symbol-keyed declaration hook a {@link Service} may implement.
 *
 * Symbol-keyed, like {@link kServiceConfigure}, because every service is also a user-facing fluent builder:
 * `ServerBuilder`, `KafkaBuilder`, `AuthenticationBuilder`. A plain method name would put the framework's own
 * lifecycle into that autocomplete surface, and `configure` in particular already means the *opposite* thing
 * on the options builders (`ViewBuilder.configure(options)` — "configure yourself with these").
 */
export const kServiceDeclare = Symbol('declare')

/** Symbol-keyed configuration hook a {@link Service} implements. */
export const kServiceConfigure = Symbol('configure')

/**
 * A unit of application configuration that binds values into the container at `ready()` time, before
 * `container.init()`. Builders (auth, cache, view, ...) and plugin-contributed configurers implement it.
 *
 * The two steps run in order across every service — every declaration finishes, then configuration resolves,
 * then every configure runs. That ordering is what lets a feature read its own resolved settings while it is
 * still able to bind, which is the whole reason the steps are separate.
 */
export interface Service {
  /**
   * Contributes to the configuration tree: framework defaults, the values the builder methods collected, and
   * this feature's slice.
   *
   * Runs **before** configuration resolves, so nothing here may read a resolved value — a slice read at this
   * point throws `ERR_CONFIG_NOT_RESOLVED`. Optional: a service with nothing to declare omits it.
   */
  [kServiceDeclare]?(kit: DeclareKit): void | Promise<void>

  /**
   * Binds this feature into the container, with its configuration already resolved and every slice published.
   *
   * A value read here is a **snapshot**: it is read once, while binding. A feature that has to follow a later
   * refresh must hold the slice and read through it, as the server and cache options do.
   */
  [kServiceConfigure](kit: ServiceKit): Promise<void>
}
