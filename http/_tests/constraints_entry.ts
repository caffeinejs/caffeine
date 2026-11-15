import { errMessage } from '@caffeinejs/std/err'

import { ErrConfiguration } from '../core/error/common.js'
import { HTTPPlugin } from '../plugin.js'

// The engine's equivalent of Fastify's `constraints()`: `version` and `host` need nothing installed there, and a
// strategy is a server setting, so one passed here is refused rather than dropped.
export function constraints(strategies?: unknown): () => HTTPPlugin {
  if (strategies !== undefined) {
    throw new ErrConfiguration(
      errMessage('Cannot take constraint strategies from constraints() on the engine: they are a server setting')
        .solutions('Return them from ".server(...)": "{ constraints: [strategy] }"')
        .reference('@caffeinejs/http', ErrConfiguration)
        .build(),
    )
  }

  return () =>
    new (class extends HTTPPlugin {
      register(): void {
        // Nothing to install: the engine matches constraints by itself.
      }
    })()
}
