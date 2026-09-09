import { feature, type Feature } from '@caffeinejs/std'

import { MultipartBuilder } from './builder.js'

/**
 * The `@caffeinejs/multipart` application feature. `.extend(MultipartExt())` registers `@fastify/multipart`
 * so `$multipart.*` pickers can read the request; pass a callback to configure through
 * {@link MultipartBuilder.options}.
 *
 * Import `$multipart` from `@caffeinejs/multipart` at the controller (or any module that builds
 * `@Args([...])`) — the feature does not patch HTTP `$p`.
 */
export const MultipartExt = (): Feature<MultipartBuilder> => feature('multipart', () => new MultipartBuilder())
