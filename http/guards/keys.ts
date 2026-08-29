import type { Key } from '@caffeinejs/di'
import type { Guard } from './guard.js'

export const kGlobalGuards = Symbol('caffeine:http:global-guards')
export const kGuardOptions = Symbol('caffeine:http:guard-options')

export type GuardRef = Key<Guard>
