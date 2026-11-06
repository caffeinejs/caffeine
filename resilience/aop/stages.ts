import { type Annotation, type AnyClass, reflect } from '@caffeinejs/di'
import { errMessage } from '@caffeinejs/std/err'

import { ErrInvalidOption } from '../errors.js'
import {
  ANNOTATIONS,
  Bulkhead,
  CircuitBreaker,
  Fallback,
  RateLimiter,
  Resilient,
  Retry,
  TimeLimiter,
} from './annotations.js'
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
const STAGES: readonly (readonly [ResilienceKind, Annotation<unknown, 'class' | 'method'>, string])[] = [
  ['retry', Retry, 'Retry'],
  ['circuitBreaker', CircuitBreaker, 'CircuitBreaker'],
  ['rateLimiter', RateLimiter, 'RateLimiter'],
  ['timeLimiter', TimeLimiter, 'TimeLimiter'],
  ['bulkhead', Bulkhead, 'Bulkhead'],
]

// The preset an annotation names, `false` when it takes the policy away, or `undefined` when there is none.
type Named = string | false | undefined

// What a stage annotation or `@Resilient` stored: the preset it names, or `false`.
function presetOf(value: unknown): Named {
  return typeof value === 'object' && value !== null ? (value as { preset: string | false }).preset : (value as Named)
}

function onClass(cls: AnyClass): boolean {
  return reflect.get(cls, Resilient) !== undefined || STAGES.some(([, annotation]) => reflect.get(cls, annotation))
}

// The nearest declaration of `member` up the prototype chain, read without calling a getter.
function declared(cls: AnyClass, member: Member): PropertyDescriptor | undefined {
  for (let proto = cls.prototype as object | null; proto !== null && proto !== Object.prototype;) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, member)
    if (descriptor !== undefined) {
      return descriptor
    }
    proto = Object.getPrototypeOf(proto) as object | null
  }
  return undefined
}

function isAsync(value: unknown): boolean {
  return Object.prototype.toString.call(value) === '[object AsyncFunction]'
}

// Whether a class-level annotation reaches `member`: a method declared `async`, which no `@Fallback` names.
function reaches(cls: AnyClass, member: Member): boolean {
  if (member === 'constructor' || !isAsync(declared(cls, member)?.value)) {
    return false
  }
  for (const fallback of reflect.members(cls, Fallback).values()) {
    if (fallback.method === member) {
      return false
    }
  }
  return true
}

/**
 * Every instance method of `cls` the aspect weaves: one that carries a resilience annotation, inherited ones
 * included, and every method a class-level annotation reaches.
 */
export function wovenMembers(cls: AnyClass): Set<Member> {
  const members = new Set<Member>()
  for (const annotation of ANNOTATIONS.keys()) {
    for (const member of reflect.members(cls, annotation).keys()) {
      members.add(member)
    }
  }

  if (onClass(cls)) {
    for (let proto = cls.prototype as object | null; proto !== null && proto !== Object.prototype;) {
      for (const member of Reflect.ownKeys(proto)) {
        if (reaches(cls, member)) {
          members.add(member)
        }
      }
      proto = Object.getPrototypeOf(proto) as object | null
    }
  }
  return members
}

/** Whether the aspect weaves `cls.member`. */
export function woven(cls: AnyClass, member: Member): boolean {
  for (const annotation of ANNOTATIONS.keys()) {
    if (reflect.get(cls, annotation, member) !== undefined) {
      return true
    }
  }
  return onClass(cls) && reaches(cls, member)
}

/**
 * Checks the presets the annotations on `cls` itself name, whether or not they reach a method.
 *
 * @throws {@link ErrInvalidOption} when one names a preset nothing defines, or a stage annotation names a preset that
 * defines no policy of its kind.
 */
export function checkClassPresets(cls: AnyClass, registry: ResilienceRegistry): void {
  const resilient = presetOf(reflect.get(cls, Resilient))
  if (typeof resilient === 'string' && !registry.has(resilient)) {
    throw undefinedPreset(cls.name, resilient, 'Resilient')
  }
  for (const [kind, annotation, decorator] of STAGES) {
    const preset = presetOf(reflect.get(cls, annotation))
    if (typeof preset === 'string' && !registry.has(preset, kind)) {
      throw registry.has(preset)
        ? missingPolicy(cls.name, preset, kind, decorator)
        : undefinedPreset(cls.name, preset, decorator)
    }
  }
}

function undefinedPreset(where: string, preset: string, decorator: string): ErrInvalidOption {
  return new ErrInvalidOption(
    errMessage(`Cannot weave "${where}": no preset named "${preset}" is defined`)
      .solutions(
        `Define it with Resilience(r => r.preset('${preset}', p => ...))`,
        `Fix the name in ${written({ preset, decorator })}`,
      )
      .reference('@caffeinejs/resilience', ErrInvalidOption)
      .build(),
  )
}

function missingPolicy(where: string, preset: string, kind: ResilienceKind, decorator: string): ErrInvalidOption {
  return new ErrInvalidOption(
    errMessage(`Cannot weave "${where}": preset "${preset}" defines no ${labelOf(kind)}`)
      .solutions(
        `Add one with r.preset('${preset}', p => p.${kind}({ ... }))`,
        `Name a preset that defines one in @${decorator}(...)`,
      )
      .reference('@caffeinejs/resilience', ErrInvalidOption)
      .build(),
  )
}

// The first candidate that names a preset or `false` decides the kind. A `@Resilient` preset that defines no policy of
// the kind is passed over; a stage annotation's is refused.
function firstStage(
  where: string,
  kind: ResilienceKind,
  decorator: string,
  registry: ResilienceRegistry,
  candidates: readonly (readonly [Named, string])[],
): StageSource | undefined {
  for (const [preset, from] of candidates) {
    if (preset === false) {
      return undefined
    }
    if (preset === undefined) {
      continue
    }
    if (registry.has(preset, kind)) {
      return { preset, decorator: from }
    }
    if (from !== 'Resilient') {
      throw missingPolicy(where, preset, kind, decorator)
    }
  }
  return undefined
}

/** How a message writes the decorator that names a stage, such as `@Retry('ledger')`. */
export function written(source: StageSource): string {
  return `@${source.decorator}('${source.preset}')`
}

/**
 * Resolves the policies of `cls.member`, kind by kind, from the first of these that names a preset or `false`: the
 * method's stage annotation, the method's `@Resilient`, the class's stage annotation, the class's `@Resilient`. A
 * `@Resilient` speaks only for the kinds its preset defines, and the class only for a method it reaches.
 *
 * @throws {@link ErrInvalidOption} when an annotation names a preset nothing defines, or a stage annotation names a
 * preset that defines no policy of its kind.
 */
export function stagesOf(cls: AnyClass, member: Member, registry: ResilienceRegistry): MethodStages {
  const where = `${cls.name}.${String(member)}`
  const checked = (preset: Named, decorator: string): Named => {
    if (typeof preset === 'string' && !registry.has(preset)) {
      throw undefinedPreset(where, preset, decorator)
    }
    return preset
  }

  const fromClass = onClass(cls) && reaches(cls, member)
  const ownResilient = reflect.get(cls, Resilient, member)
  const classResilient = fromClass ? reflect.get(cls, Resilient) : undefined
  // `@Resilient(false)` on the method keeps the class's preset off it; the class's stage annotations still reach it.
  const ownPreset = checked(ownResilient?.preset, 'Resilient')
  const resilient = [
    ownPreset === false ? undefined : ownPreset,
    ownPreset === false || classResilient?.preset === false ? undefined : checked(classResilient?.preset, 'Resilient'),
  ]

  const stages: { [K in ResilienceKind]?: StageSource } = {}
  for (const [kind, annotation, decorator] of STAGES) {
    const own = checked(presetOf(reflect.get(cls, annotation, member)), decorator)
    const inherited = fromClass ? checked(presetOf(reflect.get(cls, annotation)), decorator) : undefined
    // Method before class; at each level, the stage annotation before `@Resilient`.
    const source = firstStage(where, kind, decorator, registry, [
      [own, decorator],
      [resilient[0], 'Resilient'],
      [inherited, decorator],
      [resilient[1], 'Resilient'],
    ])
    if (source !== undefined) {
      stages[kind] = source
    }
  }

  const retry = reflect.get(cls, Retry, member) ?? (fromClass ? reflect.get(cls, Retry) : undefined)
  const repeatable = (retry?.repeatable ?? false) || ((ownResilient ?? classResilient)?.repeatable ?? false)
  return { stages, repeatable }
}
