import type { Plugin, ServiceAPI } from '@caffeinejs/std'
import { CompressBuilder } from './builder.js'

/**
 * Builder methods contributed by {@link CompressExt}.
 */
export interface CompressExt {
  /**
   * Activates compression with `@fastify/compress` defaults.
   */
  compress<Self>(this: Self): Self
  /**
   * Activates compression. Configure Fastify options through {@link CompressBuilder.options}.
   */
  compress<Self>(this: Self, configure: (c: ServiceAPI<CompressBuilder>) => void): Self
}

/**
 * The `@caffeinejs/compress` application plugin. Pass it to
 * `createWebApplication(...).extend(CompressExt())` then call `.compress()` so the adapter registers
 * `@fastify/compress`. Per-route overrides use the `compress()` extension or the `@Compress` decorator.
 *
 * On the first `.compress(...)` call it lazily creates a single {@link CompressBuilder} and registers it as
 * a service; the builder's `bootstrap()` binds the compress server extension.
 */
export function CompressExt(): Plugin<CompressExt> {
  let builder: CompressBuilder | undefined

  return {
    name: 'compress',
    install(ctx) {
      return {
        compress(configure?: (c: CompressBuilder) => void) {
          if (builder == null) {
            builder = new CompressBuilder()
            ctx.addService(builder)
          }

          configure?.(builder)

          return this
        },
      } as unknown as CompressExt
    },
  }
}
