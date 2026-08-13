import { kServiceConfigure, Service, ServiceKit } from '../service.js'
import { kViewOptions } from './keys.js'
import type { ViewOptions } from './view.js'

/**
 * Configures the view feature: the `@fastify/view` options that back server-side rendering. Bound via
 * `app.view(v => v.engine({ handlebars }).root(dir).viewExt('hbs'))`.
 *
 * A {@link Service}, like `CacheBuilder`/`ServerBuilder` — its {@link kServiceConfigure} binds the
 * assembled {@link ViewOptions} into the container under {@link kViewOptions}. The template engine is
 * user-supplied; Caffeine never depends on one directly.
 */
export class ViewBuilder implements Service {
  #options: Partial<ViewOptions> = {}

  /** The template engine, user-supplied — e.g. `.engine({ handlebars })`. Required by `@fastify/view`. */
  engine(engine: ViewOptions['engine']): this {
    this.#options.engine = engine
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

  /** Default template extension (e.g. `'hbs'`), so handlers can return `View('home')` without it. */
  viewExt(ext: string): this {
    this.#options.viewExt = ext
    return this
  }

  /** Default layout template wrapped around every rendered view. */
  layout(path: string): this {
    this.#options.layout = path
    return this
  }

  /** Data merged into every template's model. */
  defaultContext(context: object): this {
    this.#options.defaultContext = context
    return this
  }

  /** Engine-specific options forwarded to the engine. */
  options(engineOptions: object): this {
    this.#options.options = engineOptions
    return this
  }

  /** Toggles `@fastify/view`'s production template cache. */
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

  [kServiceConfigure](kit: ServiceKit): Promise<void> {
    kit.container.bind(kViewOptions).toValue(this.#options as ViewOptions).internal()
    return Promise.resolve()
  }
}
