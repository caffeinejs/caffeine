import type { Plugin, ServiceAPI } from '@caffeinejs/std'
import { HTMLBuilder } from './builder.js'

/**
 * Builder methods contributed by {@link HTMLExt}.
 */
export interface HTMLExt {
  /**
   * Renders `HTML(...)` responses with the framework defaults.
   */
  html<Self>(this: Self): Self
  /**
   * Renders `HTML(...)` responses. Change what they start from through {@link HTMLBuilder.contentType}
   * and {@link HTMLBuilder.autoDoctype}.
   */
  html<Self>(this: Self, configure: (h: ServiceAPI<HTMLBuilder>) => void): Self
}

/**
 * The `@caffeinejs/html` application plugin. Pass it to
 * `createWebApplication(...).extend(HTMLExt())` then call `.html()` to set application-wide response
 * defaults. Installing it is optional: `HTML(...)` renders without it.
 *
 * On the first `.html(...)` call it lazily creates a single {@link HTMLBuilder} and registers it as a
 * service; the builder's `bootstrap()` binds the html server extension.
 */
export function HTMLExt(): Plugin<HTMLExt> {
  let builder: HTMLBuilder | undefined

  return {
    name: 'html',
    install(ctx) {
      return {
        html(configure?: (h: HTMLBuilder) => void) {
          if (builder == null) {
            builder = new HTMLBuilder()
            ctx.addService(builder)
          }

          configure?.(builder)

          return this
        },
      } as unknown as HTMLExt
    },
  }
}
