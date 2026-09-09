import { feature, type Feature } from '@caffeinejs/std'

import { StaticBuilder } from './builder.js'

/**
 * The `@caffeinejs/static` application feature. `.extend(StaticExt(), s => s.serve(root))` adds static
 * file serving (`@fastify/static`) without http depending on this package.
 */
export const StaticExt = (): Feature<StaticBuilder> => feature('static', () => new StaticBuilder())
