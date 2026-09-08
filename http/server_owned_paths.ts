/**
 * URL prefixes the server answers on itself, outside the compiled routing.
 *
 * A fallback that serves something for every unmatched path — a SPA shell, most of all — has to know which
 * paths are not really unmatched. The compiled routes cover the application's own; this covers what a feature
 * registered directly on the server, which no route group describes: the health probes, an OIDC callback, a
 * metrics endpoint.
 *
 * Bound polymorphically, so a feature declares what it owns without any reader naming that feature:
 *
 * ```ts
 * kit.container.bind(HealthOwnedPaths, t => t.toValue(new HealthOwnedPaths(paths)).extends(ServerOwnedPaths))
 * ```
 *
 * Read with `container.getManyOptional(ServerOwnedPaths)`, once the container has initialized.
 */
export abstract class ServerOwnedPaths {
  abstract readonly paths: readonly string[]
}

/** Every path the registered features own, flattened. Empty when nothing registered any. */
export function serverOwnedPaths(providers: readonly ServerOwnedPaths[]): string[] {
  return providers.flatMap(provider => [...provider.paths])
}
