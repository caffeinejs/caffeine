import { ContainerBindingOps, allOf } from '@caffeine/core'
import { kHealthRoutes } from '../keys.js'
import { healthRoutes } from './health.routes.js'
import { HealthCheck } from './health.js'

export function healthModule(container: ContainerBindingOps): void {
  container.bind(kHealthRoutes).toFunction(healthRoutes, [allOf(HealthCheck)])
}
