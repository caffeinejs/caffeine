import { token } from '@caffeinejs/di'

import type { ServerOptions } from './server_builder.js'

/**
 * The server address settings ({@link ServerOptions}) — the port and host the adapter listens on. Bound by the
 * server builder, which every HTTP application registers, so the key always answers.
 */
export const kServerOptions = token<ServerOptions>(Symbol('caffeine.http.server.options'))
