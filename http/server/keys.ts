import { token } from '@caffeinejs/di'
import type { ServerOptions } from './server_builder.js'

/**
 * DI key for the server address options ({@link ServerOptions}) — the port and host the adapter listens on.
 * Bound by `app.server(s => s.port(...).host(...))`. When unbound, {@link DEFAULT_SERVER_OPTIONS} applies.
 */
export const kServerOptions = token<ServerOptions>(Symbol.for('@caffeinejs/http:server.options'))
