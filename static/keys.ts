import { featureConfigKey } from '@caffeinejs/std/config'

import type { ResolvedStatic } from './static.js'

/**
 * Where the resolved mounts and SPA settings are published.
 *
 * Read with `container.get(Configuration).config(kStaticConfig)` — or `ctx.config(kStaticConfig)` on a
 * request — to see what the feature actually serves after the configuration tree and the builder were
 * folded together. `undefined` when the feature is not installed.
 */
export const kStaticConfig = featureConfigKey<ResolvedStatic>('static')
