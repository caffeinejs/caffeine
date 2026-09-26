import type { InjectionToken } from '@caffeinejs/di'
import type { BaseGuard } from '@caffeinejs/std/framework'

import { UseGuards, type Guard, type GuardInput } from '../index.js'

/**
 * One guard class serves several transports by implementing each one's guard interface, and the literal `kind`
 * on each transport's input is what keeps that honest. Nothing at run time checks a guard against the transport
 * it is attached to, so this file is what holds it: `npm run test:typecheck` is the test.
 */

// Stands in for a second transport's guard types, declared the way a gRPC package would declare them.
interface GRPCGuardInput {
  readonly kind: 'grpc'
  readonly context: { readonly metadata: Map<string, string> }
}

interface GRPCGuard extends BaseGuard<GRPCGuardInput> {}

declare function useGRPCGuards(...guards: InjectionToken<GRPCGuard>[]): void

class HTTPOnlyGuard implements Guard {
  guard(input: GuardInput): boolean {
    return input.context.req.hasHeader('x-tenant')
  }
}

class GRPCOnlyGuard implements GRPCGuard {
  guard(input: GRPCGuardInput): boolean {
    return input.context.metadata.has('x-tenant')
  }
}

class TenantGuard implements Guard, GRPCGuard {
  guard(input: GuardInput | GRPCGuardInput): boolean {
    return input.kind === 'http' ? input.context.req.hasHeader('x-tenant') : input.context.metadata.has('x-tenant')
  }
}

// A guard written for both transports attaches to both.
UseGuards(TenantGuard)
useGRPCGuards(TenantGuard)

// @ts-expect-error a guard of another transport is not an HTTP guard
UseGuards(GRPCOnlyGuard)

// @ts-expect-error an HTTP-only guard is not a guard of another transport
useGRPCGuards(HTTPOnlyGuard)

class NarrowParamGuard implements Guard, GRPCGuard {
  // @ts-expect-error a guard written for both transports must accept both inputs
  guard(_input: GuardInput): boolean {
    return true
  }
}

class UnnarrowedGuard implements Guard, GRPCGuard {
  guard(input: GuardInput | GRPCGuardInput): boolean {
    // @ts-expect-error a guard written for both transports reads one's context only after narrowing on `kind`
    return input.context.req.hasHeader('x-tenant')
  }
}

void [NarrowParamGuard, UnnarrowedGuard]
