import { token } from '@caffeinejs/di'

import type { ConstraintRegistry } from './registry.js'

export const kConstraintRegistry = token<ConstraintRegistry>(Symbol('caffeine:http:constraint-registry'))
