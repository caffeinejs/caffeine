// Which adapter a built-in plugin runs on, while the Fastify adapter and the engine both exist. Read by path, never
// through a barrel: no application marks a plugin.

/** On an `HTTPPlugin` that runs on the engine alone: the name the Fastify entry exports in its place. */
export const kEngineOnly: unique symbol = Symbol('caffeine.http.engine-only')

/** On a Fastify plugin function Caffeine returns: the name the engine exports in its place. */
export const kFastifyOnly: unique symbol = Symbol('caffeine.http.fastify-only')
