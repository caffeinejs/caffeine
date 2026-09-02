import type { Plugin, ServiceAPI } from '@caffeinejs/std'
import { MultipartBuilder } from './builder.js'

/**
 * Builder methods contributed by {@link MultipartExt}.
 */
export interface MultipartExt {
  /**
   * Activates multipart uploads with `@fastify/multipart` defaults.
   */
  multipart<Self>(this: Self): Self
  /**
   * Activates multipart uploads. Configure Fastify options through {@link MultipartBuilder.options}.
   */
  multipart<Self>(this: Self, configure: (m: ServiceAPI<MultipartBuilder>) => void): Self
}

/**
 * The `@caffeinejs/multipart` application plugin. Pass it to
 * `createWebApplication(...).extend(MultipartExt())` then call `.multipart()` so the adapter registers
 * `@fastify/multipart` and `$multipart.*` pickers can read the request.
 *
 * Import `$multipart` from `@caffeinejs/multipart` at the controller (or any module that builds
 * `@Args([...])`) — the plugin does not patch HTTP `$p`.
 *
 * On the first `.multipart(...)` call it lazily creates a single {@link MultipartBuilder} and registers it as
 * a service; the builder's `configure()` binds the multipart server extension.
 */
export function MultipartExt(): Plugin<MultipartExt> {
  let builder: MultipartBuilder | undefined

  return {
    name: 'multipart',
    install(ctx) {
      return {
        multipart(configure?: (m: MultipartBuilder) => void) {
          if (builder == null) {
            builder = new MultipartBuilder()
            ctx.addService(builder)
          }

          configure?.(builder)

          return this
        },
      } as unknown as MultipartExt
    },
  }
}
