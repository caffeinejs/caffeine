#!/usr/bin/env node
import { parseArgs } from 'node:util'

import { EnvConfigSource } from '@caffeinejs/std/config/env'
import { YAMLConfigSource } from '@caffeinejs/std/config/yaml'
import { errMessage } from '@caffeinejs/std/framework/err'

import { createDevToolsUI } from './application.js'

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

const { values } = parseArgs({
  options: {
    config: { type: 'string', short: 'c', default: 'devtools.yaml' },
  },
})

const app = createDevToolsUI({
  sources: [
    new YAMLConfigSource(values.config, { optional: false }),
    new EnvConfigSource({ prefix: 'CAFFEINE_DEVTOOLS_' }),
  ],
})

// No signal handling here: the application's shutdown policy drains and closes on SIGTERM and SIGINT.
const { address } = await app.run()

if (address !== undefined) {
  app.log.info(`DevTools UI at ${address.origin}`)

  if (!LOOPBACK.has(address.host)) {
    app.log.warn(
      errMessage(
        `The DevTools UI listens on "${address.host}": it has no login, and whoever reaches it reads every application it is configured with`,
      )
        .solutions('Set "server.host" to "127.0.0.1", and reach it through a tunnel')
        .build(),
    )
  }
}
