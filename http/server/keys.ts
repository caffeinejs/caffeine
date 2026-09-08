import { featureConfigKey } from '@caffeinejs/std/config'

import type { ServerOptions } from './server_builder.js'

/**
 * The server address settings ({@link ServerOptions}) — the port and host the adapter listens on. Published by
 * the server builder, which every HTTP application registers, so the key always answers.
 * {@link DEFAULT_SERVER_OPTIONS} applies to whatever the application did not set.
 */
export const kServerConfig = featureConfigKey<ServerOptions>('http:server')
