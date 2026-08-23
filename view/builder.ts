import { ErrConfiguration } from '@caffeinejs/http'
import type { ViewOptions } from './view.js'

/**
 * ViewBuilder configures a single SSR (Server-Side Rendering) engine, powered by the `@fastify/view`
 * plugin. The same options used to configure the `@fastify/view` plugin can be used to configure the
 * Caffeine's SSR. In case the builder does not provide a specific option, use the `configure` method to
 * set any option supported by the `@fastify/view` plugin.
 *
 * One builder assembles one engine registration. Multiple engines are declared by calling
 * `app.view(name, ...)` once per engine; the {@link ViewOptionsProvider} owns them and reads each via
 * {@link build}.
 *
 * @see https://github.com/fastify/point-of-view
 */
export class ViewBuilder {
  readonly #name: string | undefined
  #options: Partial<ViewOptions> = {}

  /**
   * @param name - The engine registration name (`@fastify/view`'s `propertyName`), decorating
   *   `reply.<name>`. `undefined` is the default engine, decorating `reply.view`.
   */
  constructor(name?: string) {
    this.#name = name
  }

  /**
   * Configures the template engine.
   * Accepted engines are: ejs, eta, nunjucks, pug, handlebars, mustache, twig, liquid, dot, edge, squirrelly.
   *
   * @param engine - The template engine.
   * @param options - The engine-specific options.
   */
  engine(engine: ViewOptions['engine'], options?: object): this {
    this.#options.engine = engine
    this.#options.options = options

    return this
  }

  /**
   * Directory (or directories) templates are resolved against. An array searches each path in order
   * (first match wins) — enabling feature-folder views with a shared layout root, e.g.
   * `['src/orders/views', 'src/users/views', 'src/shared/layouts']`.
   *
   * Array roots are **engine-dependent**: `@fastify/view` only honors them for **Nunjucks** (it throws for
   * Handlebars/EJS/etc). With a single-root engine, use one `root` and namespaced template names
   * (`View('orders/list')`). `@fastify/view` accepts `string[]` at runtime though its types declare only
   * `string`, hence the cast.
   */
  root(root: string | string[]): this {
    this.#options.root = root as ViewOptions['root']
    return this
  }

  /**
   * Default template extension (e.g. `'hbs'`), so handlers can return `View('home')` without it.
   */
  extension(ext: string): this {
    this.#options.viewExt = ext
    return this
  }

  /**
   * Default layout template wrapped around every rendered view.
   */
  layout(path: string): this {
    this.#options.layout = path
    return this
  }

  /**
   * Data merged into every template's model.
   */
  defaultContext(context: object): this {
    this.#options.defaultContext = context
    return this
  }

  /**
   * Engine-specific options forwarded to the underlying engine.
   */
  options(engineOptions: object): this {
    this.#options.options = engineOptions
    return this
  }

  /**
   * Toggles `@fastify/view`'s production template cache.
   */
  production(production: boolean): this {
    this.#options.production = production
    return this
  }

  /**
   * Merges a full `@fastify/view` options object over anything set so far (last write wins). The escape
   * hatch for knobs without a fluent setter (`charset`, `maxCache`, `includeViewExtension`,
   * `propertyName`, `templates`, ...). Interleaves with the fluent setters by call order.
   */
  configure(options: Partial<ViewOptions>): this {
    Object.assign(this.#options, options)
    return this
  }

  /**
   * Assembles the `@fastify/view` options for this engine registration, stamping `propertyName` when the
   * builder is named. Throws when no engine was configured.
   */
  build(): ViewOptions {
    if (!this.#options.engine) {
      throw new ErrConfiguration('Engine is required to configure Server-Side Rendering')
    }

    if (this.#name !== undefined) {
      this.#options.propertyName = this.#name
    }

    return this.#options as ViewOptions
  }
}
