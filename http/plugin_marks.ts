// Which adapter a built-in plugin runs on, while the Fastify adapter and the engine both exist. Read by path, never
// through a barrel: no application marks a plugin.

/** What a Fastify application says when handed an engine-only plugin. */
export interface EngineOnly {
  /** The factory the refusal names: `csrf` for `csrf()`. */
  readonly factory: string
  /** The refusal's one solution: what to use on Fastify instead. */
  readonly instead: string
}

/** On an `HTTPPlugin` that runs on the engine alone: an {@link EngineOnly}. */
export const kEngineOnly: unique symbol = Symbol('caffeine.http.engine-only')

/** On a Fastify plugin function Caffeine returns: the name the engine exports in its place. */
export const kFastifyOnly: unique symbol = Symbol('caffeine.http.fastify-only')
