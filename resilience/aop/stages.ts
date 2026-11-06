import { type Annotation, type AnyClass, reflect } from '@caffeinejs/di'
import { errMessage } from '@caffeinejs/std/err'

import { ErrInvalidOption } from '../errors.js'
import { ANNOTATIONS, Bulkhead, CircuitBreaker, RateLimiter, Resilient, Retry, TimeLimiter } from './annotations.js'
import { labelOf, type ResilienceKind, type ResilienceRegistry } from './registry.js'

type Member = string | symbol

/** Where a method's policy of one kind comes from: the preset, and the decorator that names it. */
export interface StageSource {
  readonly preset: string
  /** The decorator's name, such as `Retry` or `Resilient`. */
  readonly decorator: string
}

/** The policies a method runs through, by kind, and whether it declares that running it twice is safe. */
export interface MethodStages {
  readonly stages: { readonly [K in ResilienceKind]?: StageSource }
  readonly repeatable: boolean
}

// The annotation that names each kind's preset, and its decorator's name.
const STAGES: readonly (readonly [ResilienceKind, Annotation<unknown, 'method'>, string])[] = [
  ['retry', Retry, 'Retry'],
  ['circuitBreaker', CircuitBreaker, 'CircuitBreaker'],
  ['rateLimiter', RateLimiter, 'RateLimiter'],
  ['timeLimiter', TimeLimiter, 'TimeLimiter'],
  ['bulkhead', Bulkhead, 'Bulkhead'],
]

/** Every instance method of `cls` that carries a resilience annotation, inherited ones included. */
export function annotatedMembers(cls: AnyClass): Set<Member> {
  const members = new Set<Member>()
  for (const annotation of ANNOTATIONS.keys()) {
    for (const member of reflect.members(cls, annotation).keys()) {
      members.add(member)
    }
  }
  return members
}

/** How a message writes the decorator that names a stage, such as `@Retry('ledger')`. */
export function written(source: StageSource): string {
  return `@${source.decorator}('${source.preset}')`
}

function presetOf(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null ? (value as { preset: string }).preset : (value as string)
}

/**
 * Resolves the policies of `cls.member`: each kind from its stage annotation, otherwise from the preset `@Resilient`
 * names when that preset defines one.
 *
 * @throws {@link ErrInvalidOption} when an annotation names a preset nothing defines, or a stage annotation names a
 * preset that defines no policy of its kind.
 */
export function stagesOf(cls: AnyClass, member: Member, registry: ResilienceRegistry): MethodStages {
  const where = `${cls.name}.${String(member)}`
  const missing = (source: StageSource): ErrInvalidOption =>
    new ErrInvalidOption(
      errMessage(`Cannot weave "${where}": no preset named "${source.preset}" is defined`)
        .solutions(
          `Define it with Resilience(r => r.preset('${source.preset}', p => ...))`,
          `Fix the name in ${written(source)}`,
        )
        .reference('@caffeinejs/resilience', ErrInvalidOption)
        .build(),
    )

  const resilient = reflect.effective(cls, Resilient, member)
  if (resilient !== undefined && !registry.has(resilient.preset)) {
    throw missing({ preset: resilient.preset, decorator: 'Resilient' })
  }

  const stages: { [K in ResilienceKind]?: StageSource } = {}
  for (const [kind, annotation, decorator] of STAGES) {
    const preset = presetOf(reflect.effective(cls, annotation, member))
    if (preset === undefined) {
      if (resilient !== undefined && registry.has(resilient.preset, kind)) {
        stages[kind] = { preset: resilient.preset, decorator: 'Resilient' }
      }
      continue
    }

    const source = { preset, decorator }
    if (!registry.has(preset)) {
      throw missing(source)
    }
    if (!registry.has(preset, kind)) {
      throw new ErrInvalidOption(
        errMessage(`Cannot weave "${where}": preset "${preset}" defines no ${labelOf(kind)}`)
          .solutions(
            `Add one with r.preset('${preset}', p => p.${kind}({ ... }))`,
            `Name a preset that defines one in @${decorator}(...)`,
          )
          .reference('@caffeinejs/resilience', ErrInvalidOption)
          .build(),
      )
    }
    stages[kind] = source
  }

  const repeatable = (reflect.effective(cls, Retry, member)?.repeatable ?? false) || (resilient?.repeatable ?? false)
  return { stages, repeatable }
}
