/**
 * The label a transport gives every class whose methods it calls on a request, such as an HTTP controller. A
 * retry on such a class replays what the request did, so `Resilience()` refuses one that no installed
 * {@link ResilienceTransport} claims.
 */
export const kEntrypoint = Symbol.for('@caffeinejs:entrypoint')

/**
 * A transport's integration with the resilience annotations, such as `ResilienceHTTP()`. It claims the entrypoint
 * classes that carry its `label`, and owns their replay check: it resolves each entrypoint method with `stagesOf`
 * and refuses a retry the transport cannot replay. It also maps `failureOf(error)` to its own status.
 *
 * A transport's feature binds a subclass with `.extends(ResilienceTransport)`:
 *
 * ```ts
 * class GRPCTransport extends ResilienceTransport {
 *   readonly label = kGRPCService
 * }
 *
 * kit.container.bind(GRPCTransport, t => t.toSelf().extends(ResilienceTransport))
 * ```
 */
export abstract class ResilienceTransport {
  /** The label the transport gives its entrypoint classes, beside {@link kEntrypoint}. */
  abstract readonly label: symbol
}
