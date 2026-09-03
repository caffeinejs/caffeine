import type { InjectionToken } from '@caffeinejs/di'
import type { WebApplication } from '@caffeinejs/http'

import type { DevtoolsStore } from '../store.js'
import type { RouteSnapshot } from '../types.js'

export class HTTPCollector {
  constructor(private readonly store: DevtoolsStore) {}

  attach(app: WebApplication<any, any, any>): void {
    const snapshots: RouteSnapshot[] = []

    for (const router of app.routeGroups) {
      // Only a group declared by a class has a binding to report a scope for. One declared any other way
      // has no instance behind it, and says so rather than inventing a lifetime.
      const target = router.target
      const controllerScope =
        target === undefined ? '' : String(app.container.getBinding(target as InjectionToken).scopeID)

      for (const route of router.routes) {
        snapshots.push({
          method: route.method,
          path: (router.prefix ?? '') + router.path + route.path,
          controllerKey: router.name,
          controllerScope,
          handler: String(route.name),
          accept: route.accept,
          contentType: route.contentType,
          responseStatus: route.statusCode,
        })
      }
    }

    this.store.setRoutes(snapshots)
  }
}
