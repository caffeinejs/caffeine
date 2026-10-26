/** The methods an operation answers. A read is `GET`; the others change something. */
export type DevToolMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** What an operation is handed for one request. */
export interface DevToolInput {
  /** The path's parameters, by the names the operation's path gives them: `/entries/:key` has `key`. */
  readonly params: Readonly<Record<string, string>>
  readonly query: Readonly<Record<string, string | undefined>>
  /** The parsed JSON body of a `POST`, `PUT` or `PATCH`; `undefined` otherwise. */
  readonly body: unknown
  /** Aborted when the client goes away. */
  readonly signal: AbortSignal
}

/** One resource of a tool and one method on it. */
export interface DevToolOperation {
  readonly method: DevToolMethod
  /** Under the tool's own path, `''` for the tool's root: `/entries`, `/entries/:key`. */
  readonly path: string
  /** The status of a success: `200` by default, `204` when the handler returns `undefined`. */
  readonly status?: number
  /**
   * Answers with a value sent as JSON, or a promise of one. Throws {@link ErrDevToolNotFound} for a resource that
   * does not exist and {@link ErrDevToolInvalid} for input it refuses.
   */
  handle(input: DevToolInput): unknown
}

/**
 * A tool the devtools serve: a set of REST resources under `/devtools/<id>`, listed with its title in the devtools
 * index, where the devtools UI finds it.
 *
 * A package or an application contributes one by binding a subclass so that it extends this class; the devtools
 * collect every binding that does once the container has initialized. A tool reads what it reports from what it
 * injects, and knows nothing about the transport that serves it.
 *
 * @example
 * ```ts
 * @Injectable()
 * class QueueTool extends DevTool {
 *   readonly id = 'queue'
 *   readonly title = 'Job queue'
 *   readonly description = 'Pending jobs and the workers taking them'
 *   readonly operations = [
 *     { method: 'GET', path: '/jobs', handle: () => this.queue.pending() },
 *     { method: 'DELETE', path: '/jobs/:id', handle: ({ params }) => this.queue.cancel(params.id) },
 *   ] satisfies DevToolOperation[]
 *
 *   constructor(private readonly queue: Queue) {
 *     super()
 *   }
 * }
 * ```
 */
export abstract class DevTool {
  /** The path segment the tool is served under: lower-case letters, digits and dashes, starting with a letter. */
  abstract readonly id: string
  abstract readonly title: string
  /** One sentence the devtools index shows under the title. */
  abstract readonly description: string
  abstract readonly operations: readonly DevToolOperation[]
}
