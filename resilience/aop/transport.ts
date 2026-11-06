/**
 * The label a transport gives every class whose methods it calls on a request, such as an HTTP controller. A
 * retry on such a class replays what the request did, so `Resilience()` refuses one that no installed
 * {@link ResilienceTransport} claims.
 */
export const kEntrypoint = Symbol.for('@caffeinejs:entrypoint')

/**
 * A transport's integration with the resilience annotations, such as `ResilienceHTTP()`. It claims the entrypoint
 * classes that carry its `label`, and owns their replay check: it resolves each entrypoint method with `stagesOf`
 * and refuses a retry the transport cannot replay. It also maps `failureOf(error)` to its own status, and says which
 * errors are its client's own answer.
 *
 * A transport's feature binds a subclass with `.extends(ResilienceTransport)`:
 *
 * ```ts
 * // kGRPCService and isGRPCClientError are the gRPC package's own
 * class GRPCTransport extends ResilienceTransport {
 *   readonly label = kGRPCService
 *
 *   isClientError(error: unknown): boolean {
 *     return isGRPCClientError(error)
 *   }
 * }
 *
 * kit.container.bind(GRPCTransport, t => t.toSelf().extends(ResilienceTransport))
 * ```
 */
export abstract class ResilienceTransport {
  /** The label the transport gives its entrypoint classes, beside {@link kEntrypoint}. */
  abstract readonly label: symbol

  /**
   * Whether an error an entrypoint method throws is the client's own answer, such as a request for a record that does
   * not exist, rather than a failing dependency. On every call of a class the transport claims, such an error passes
   * the method's policies untouched: it is not retried, a circuit breaker records it as ignored, and a fallback does
   * not answer it. A class the entrypoint calls keeps its policies whole.
   */
  abstract isClientError(error: unknown): boolean
}
