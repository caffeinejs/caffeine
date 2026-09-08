import { contributionKey } from '@caffeinejs/std'

import type { ServerOptions } from './server_builder.js'

/**
 * The server address options ({@link ServerOptions}) — the port and host the adapter listens on. Contributed
 * by the server builder, which every HTTP application registers, so it is always present.
 * {@link DEFAULT_SERVER_OPTIONS} applies to whatever the application did not set.
 */
export const kServerContribution = contributionKey<ServerOptions>('http:server.options')
