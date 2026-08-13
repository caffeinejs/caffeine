import { kServiceConfigure, Service, ServiceKit } from '../service.js'
import { kStaticMounts } from './keys.js'
import type { StaticMount } from './static.js'

/**
 * Configures static file serving over `@fastify/static`. Bound via
 * `app.static(s => s.static(dir, { prefix: '/static' }))`.
 *
 * A {@link Service}, like `ViewBuilder`/`ServerBuilder` — its {@link kServiceConfigure} binds the assembled
 * mounts into the container under {@link kStaticMounts}. Each `.static(...)` call adds one mount; multiple
 * mounts serve multiple directories (the {@link StaticConfigurer} handles `@fastify/static`'s single-decorate
 * constraint).
 */
export class StaticBuilder implements Service {
  #mounts: StaticMount[] = []

  /**
   * Serves `root` as static files. `options` is the full `@fastify/static` options object minus `root`
   * (`prefix`, `index`, `wildcard`, `maxAge`, ...). Call again to serve additional directories.
   */
  static(root: string, options?: Omit<StaticMount, 'root'>): this {
    this.#mounts.push({ root, ...options } as StaticMount)
    return this
  }

  [kServiceConfigure](kit: ServiceKit): Promise<void> {
    kit.container.bind(kStaticMounts).toValue(this.#mounts).internal()
    return Promise.resolve()
  }
}
