import { InjectionDescriptor } from '../../injection.js'
import { Key } from '../../key.js'
import { getInjectionMetadata } from './registrar.js'
import { MemberMetadata } from './spec.js'
import { idfy } from './types.js'

const LegacyParameterInjections = new WeakMap<Function, Map<number, InjectionDescriptor>>()

/**
 * Gets the injection metadata for the given object.
 *
 * @framework
 * @legacyDecorators
 */
export function getLegacyInjectionMetadata(target: object | Function): MemberMetadata {
  return getInjectionMetadata(idfy(target))
}

/**
 * Stores a parameter injection for a legacy injectable class.
 *
 * @framework
 * @legacyDecorators
 */
export function storeLegacyParameterInjection(
  target: Function,
  parameterIndex: number,
  descriptor: InjectionDescriptor<unknown>,
): void {
  let params = LegacyParameterInjections.get(target)
  if (!params) {
    params = new Map()
    LegacyParameterInjections.set(target, params)
  }

  params.set(parameterIndex, descriptor)
}

/**
 * Gets the parameter injections for a legacy injectable class.
 *
 * @framework
 * @legacyDecorators
 */
export function getLegacyParameterInjections(target: Function): Map<number, InjectionDescriptor> | undefined {
  return LegacyParameterInjections.get(target)
}

/**
 * Builds the constructor dependencies for a legacy injectable class.
 *
 * @framework
 * @legacyDecorators
 */
export function buildLegacyConstructorDeps(target: Function, explicit: InjectionDescriptor[]): InjectionDescriptor[] {
  if (explicit.length > 0) {
    return explicit
  }

  const paramInjections = getLegacyParameterInjections(target)

  const paramTypes: unknown[]
    = typeof Reflect !== 'undefined' && typeof (Reflect as Record<string, unknown>).getMetadata === 'function'
      ? ((Reflect as Record<string, unknown>).getMetadata as (key: string, target: Function) => unknown[])(
          'design:paramtypes',
          target,
        ) ?? []
      : []

  if (paramTypes.length === 0 && (!paramInjections || paramInjections.size === 0)) {
    return []
  }

  const count = Math.max(paramTypes.length, paramInjections ? Math.max(...paramInjections.keys()) + 1 : 0)
  const deps: InjectionDescriptor[] = []

  for (let i = 0; i < count; i++) {
    const override = paramInjections?.get(i)
    if (override) {
      deps.push(override)
    } else if (paramTypes[i] && typeof paramTypes[i] === 'function') {
      deps.push({ key: paramTypes[i] as Key })
    }
  }

  return deps
}
