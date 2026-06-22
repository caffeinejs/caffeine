import { Binding } from '../../../binding.js'
import { ScopeCheckMode } from '../../../container_interface.js'
import { DeferredCtor } from '../../../deferred_ctor.js'
import { ErrScopeMismatch } from '../../../errors.js'
import { InjectionDescriptor, ObjectInjections } from '../../../injection.js'
import { BuiltInResolvers } from '../../../injection_resolver.js'
import { Key, keyStr, Identifier, TypedKey } from '../../../key.js'
import { Scope, Scopes, scopeLabel } from '../../../scope.js'

interface ScopeValidationContext {
  mode: ScopeCheckMode
  scopes: Map<Identifier, Scope>
  getBindings<T>(key: TypedKey<T>): Binding<T>[]
}

export function checkScopes(ctx: ScopeValidationContext, entries: IterableIterator<[Key, Binding]>): void {
  if (ctx.mode === 'off') {
    return
  }

  if (ctx.mode === 'no-mix') {
    checkNoMix(ctx, entries)
  } else if (ctx.mode === 'compatible-scopes-only') {
    checkCompatibleScopes(ctx, entries)
  }
}

function checkNoMix(ctx: ScopeValidationContext, entries: IterableIterator<[Key, Binding]>): void {
  runCheck(entries, ctx, (ownerScopeId, depScopeId) => ownerScopeId !== depScopeId)
}

function checkCompatibleScopes(ctx: ScopeValidationContext, entries: IterableIterator<[Key, Binding]>): void {
  runCheck(entries, ctx, (ownerScopeId, depScopeId) => isDurable(ownerScopeId, ctx) && !isDurable(depScopeId, ctx))
}

function isDurable(scopeId: Identifier, ctx: ScopeValidationContext): boolean {
  if (scopeId === Scopes.TRANSIENT) {
    return false
  }

  return ctx.scopes.get(scopeId)?.durable ?? false
}

function runCheck(
  entries: IterableIterator<[Key, Binding]>,
  ctx: ScopeValidationContext,
  isViolation: (ownerScopeId: Identifier, depScopeId: Identifier) => boolean,
): void {
  const violations: string[] = []

  for (const [ownerKey, binding] of entries) {
    for (let i = 0; i < binding.injections.length; i++) {
      checkInjection(
        ownerKey,
        binding.scopeId,
        binding.injections[i],
        `"${keyStr(ownerKey)}" constructor param[${i}]`,
        violations,
        ctx,
        isViolation,
      )
    }

    for (const [prop, desc] of binding.injectableProperties) {
      checkInjection(
        ownerKey,
        binding.scopeId,
        desc,
        `"${keyStr(ownerKey)}".${String(prop)}`,
        violations,
        ctx,
        isViolation,
      )
    }

    for (const [method, descs] of binding.injectableMethods) {
      for (let i = 0; i < descs.length; i++) {
        checkInjection(
          ownerKey,
          binding.scopeId,
          descs[i],
          `"${keyStr(ownerKey)}".${String(method)}[${i}]`,
          violations,
          ctx,
          isViolation,
        )
      }
    }
  }

  if (violations.length > 0) {
    throw new ErrScopeMismatch(violations)
  }
}

function checkInjection(
  ownerKey: Key,
  ownerScopeId: Identifier,
  inj: InjectionDescriptor,
  location: string,
  violations: string[],
  ctx: ScopeValidationContext,
  isViolation: (ownerScopeId: Identifier, depScopeId: Identifier) => boolean,
): void {
  if (inj.resolver === BuiltInResolvers.PROVIDER) {
    return
  }

  if (inj.resolver === BuiltInResolvers.OBJECT) {
    checkObjectInjection(ownerKey, ownerScopeId, inj.args as ObjectInjections, location, violations, ctx, isViolation)
    return
  }

  if (!inj.key) {
    return
  }

  const depKey = inj.key instanceof DeferredCtor ? inj.key.unwrap() : inj.key
  const depBindings = ctx.getBindings(depKey as TypedKey<unknown>)

  for (const dep of depBindings) {
    if (isViolation(ownerScopeId, dep.scopeId)) {
      violations.push(
        `"${keyStr(ownerKey)}" (${scopeLabel(ownerScopeId)}) depends on "${keyStr(depKey)}" (${scopeLabel(dep.scopeId)}) at ${location}`,
      )
    }
  }
}

function checkObjectInjection(
  ownerKey: Key,
  ownerScopeId: Identifier,
  obj: ObjectInjections,
  location: string,
  violations: string[],
  ctx: ScopeValidationContext,
  isViolation: (ownerScopeId: Identifier, depScopeId: Identifier) => boolean,
): void {
  const props: Array<string | symbol> = [...Object.keys(obj.children), ...Object.getOwnPropertySymbols(obj.children)]

  for (const prop of props) {
    const child = obj.children[prop]
    const childLocation = `${location}.${String(prop)}`

    if ('children' in child) {
      checkObjectInjection(
        ownerKey, ownerScopeId, child as ObjectInjections, childLocation, violations, ctx, isViolation,
      )
    } else {
      checkInjection(ownerKey, ownerScopeId, child as InjectionDescriptor, childLocation, violations, ctx, isViolation)
    }
  }
}
