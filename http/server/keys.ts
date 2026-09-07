import { token } from '@caffeinejs/di'
import { contributionKey } from '@caffeinejs/std'

import type { ServerOptions } from './server_builder.js'

/**
 * The server address options ({@link ServerOptions}) — the port and host the adapter listens on. Contributed
 * by the server builder, which every HTTP application registers, so it is always present.
 * {@link DEFAULT_SERVER_OPTIONS} applies to whatever the application did not set.
 */
export const kServerContribution = contributionKey<ServerOptions>('http:server.options')

/**
 * The same {@link ServerOptions} as a container binding, for a class the container constructs.
 *
 * The bound object is the slice's own, so its fields keep following a refresh — asking for it in a constructor
 * is not a snapshot. What the adapter listens on is still fixed at bind time: the application copies these
 * options immediately before binding the socket.
 */
export const kServerOptions = token<ServerOptions>(Symbol.for('@caffeinejs/http:server.options'))
