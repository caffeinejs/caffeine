import type { Adapter } from '@caffeinejs/http'
import type { DevtoolsStore } from '../store.js'
import type { RouteSnapshot } from '../types.js'

export class HttpCollector {
  constructor(private readonly store: DevtoolsStore) {}

  attach(adapter: Adapter<any, any>): void {
    const snapshots: RouteSnapshot[] = []

    for (const router of adapter.routers) {
      const controllerScope = String(router.binding.scopeId)
      const controllerKey
        = typeof router.key === 'function'
          ? (router.key as { name?: string }).name ?? String(router.key)
          : String(router.key)

      for (const route of router.routes) {
        snapshots.push({
          method: route.method,
          path: (router.prefix ?? '') + router.path + route.path,
          controllerKey,
          controllerScope,
          handler: String(route.handler),
          accept: route.accept,
          contentTypes: route.contentTypes,
          responseStatus: route.response.status,
        })
      }
    }

    this.store.setRoutes(snapshots)
  }
}
