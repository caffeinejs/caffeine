import { Binding } from '../../../binding.js'
import { ScopeCheckMode } from '../../../container_interface.js'
import { DeferredCtor } from '../../../deferred_ctor.js'
import { ErrScopeMismatch } from '../../../errors.js'
import { InjectionDescriptor, ObjectInjections } from '../../../injection.js'
import { BuiltInResolvers } from '../../../injection_resolver.js'
import { InjectionToken, keyStr, NamedToken, TypedKey } from '../../../key.js'
import { Scope, Scopes, scopeLabel } from '../../../scope.js'

interface ScopeValidationContext {
  mode: ScopeCheckMode
  scopes: Map<NamedToken<Scope>, Scope>
  getBindings<T>(key: TypedKey<T>): Binding<T>[]
}

export function checkScopes(ctx: ScopeValidationContext, entries: IterableIterator<[InjectionToken, Binding]>): void {
  if (ctx.mode === 'off') {
    return
  }

  if (ctx.mode === 'no-mix') {
    checkNoMix(ctx, entries)
  } else if (ctx.mode === 'compatible-scopes-only') {
    checkCompatibleScopes(ctx, entries)
  }
}

function checkNoMix(ctx: ScopeValidationContext, entries: IterableIterator<[InjectionToken, Binding]>): void {
  runCheck(entries, ctx, (ownerScopeID, depScopeID) => ownerScopeID !== depScopeID)
}

function checkCompatibleScopes(
  ctx: ScopeValidationContext,
  entries: IterableIterator<[InjectionToken, Binding]>,
): void {
  runCheck(entries, ctx, (ownerScopeID, depScopeID) => isDurable(ownerScopeID, ctx) && !isDurable(depScopeID, ctx))
}

function isDurable(scopeID: NamedToken<Scope>, ctx: ScopeValidationContext): boolean {
  if (scopeID === Scopes.TRANSIENT) {
    return false
  }

  return ctx.scopes.get(scopeID)?.durable ?? false
}

function runCheck(
  entries: IterableIterator<[InjectionToken, Binding]>,
  ctx: ScopeValidationContext,
  isViolation: (ownerScopeID: NamedToken<Scope>, depScopeID: NamedToken<Scope>) => boolean,
): void {
  const violations: string[] = []

  for (const [ownerKey, binding] of entries) {
    for (let i = 0; i < binding.injections.length; i++) {
      checkInjection(
        ownerKey,
        binding.scopeID,
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
        binding.scopeID,
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
          binding.scopeID,
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
  ownerKey: InjectionToken,
  ownerScopeID: NamedToken<Scope>,
  inj: InjectionDescriptor,
  location: string,
  violations: string[],
  ctx: ScopeValidationContext,
  isViolation: (ownerScopeID: NamedToken<Scope>, depScopeID: NamedToken<Scope>) => boolean,
): void {
  if (inj.resolver === BuiltInResolvers.PROVIDER) {
    return
  }

  if (inj.resolver === BuiltInResolvers.OBJECT) {
    checkObjectInjection(ownerKey, ownerScopeID, inj.args as ObjectInjections, location, violations, ctx, isViolation)
    return
  }

  if (!inj.key) {
    return
  }

  const depKey = inj.key instanceof DeferredCtor ? inj.key.unwrap() : inj.key
  const depBindings = ctx.getBindings(depKey as TypedKey<unknown>)

  for (const dep of depBindings) {
    if (isViolation(ownerScopeID, dep.scopeID)) {
      violations.push(
        `"${keyStr(ownerKey)}" (${scopeLabel(ownerScopeID)}) depends on "${keyStr(depKey)}" (${scopeLabel(dep.scopeID)}) at ${location}`,
      )
    }
  }
}

function checkObjectInjection(
  ownerKey: InjectionToken,
  ownerScopeID: NamedToken<Scope>,
  obj: ObjectInjections,
  location: string,
  violations: string[],
  ctx: ScopeValidationContext,
  isViolation: (ownerScopeID: NamedToken<Scope>, depScopeID: NamedToken<Scope>) => boolean,
): void {
  const props: Array<string | symbol> = [...Object.keys(obj.children), ...Object.getOwnPropertySymbols(obj.children)]

  for (const prop of props) {
    const child = obj.children[prop]
    const childLocation = `${location}.${String(prop)}`

    if ('children' in child) {
      checkObjectInjection(
        ownerKey,
        ownerScopeID,
        child as ObjectInjections,
        childLocation,
        violations,
        ctx,
        isViolation,
      )
    } else {
      checkInjection(ownerKey, ownerScopeID, child as InjectionDescriptor, childLocation, violations, ctx, isViolation)
    }
  }
}
