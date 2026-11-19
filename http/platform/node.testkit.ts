import { node as nodeAdapter, type NodeAdapter as BuiltNodeAdapter } from '@caffeinejs/http-node'

import type { ServerAdapter } from '../core/server/hosting.js'

type Built = NonNullable<BuiltNodeAdapter['__types']>

// Typed against this package's source: @caffeinejs/http-node's declarations name dist's kHosting.
export type NodeAdapter = ServerAdapter<Built['settings'], Built['instance'], Built['listen']>

export const node = nodeAdapter as unknown as () => NodeAdapter
