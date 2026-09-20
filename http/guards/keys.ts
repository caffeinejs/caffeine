import { token, type InjectionToken } from '@caffeinejs/di'

import type { Guard } from './guard.js'

export const kGlobalGuards = token<InjectionToken<Guard>[]>(Symbol('caffeine:http:global-guards'))
