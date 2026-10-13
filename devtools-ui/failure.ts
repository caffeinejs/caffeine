import type {
  DevToolsBindingsReport,
  DevToolsConfigurationReport,
  DevToolsHealthReport,
  DevToolsIndex,
  DevToolsInfoReport,
  DevToolsRoutesReport,
} from '@caffeinejs/devtools'
import type { BindingGraph } from '@caffeinejs/di/graph'
import { ErrFetchyHTTP } from '@caffeinejs/fetchy'

/** What went wrong calling an application. */
export type FailureKind =
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'server-error'
  | 'http-error'
  | 'timeout'
  | 'unreachable'
  | 'invalid-response'

export interface Failure {
  readonly kind: FailureKind
  /** The status the application answered with. */
  readonly status?: number
  /** The system error that kept the call from reaching the application: `ECONNREFUSED`, `ENOTFOUND`. */
  readonly code?: string
}

export type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: Failure }

/**
 * Calls an application, turning what can go wrong talking to it into a {@link Failure}, and an answer that is not
 * the shape asked for into an invalid response. Anything else is a fault of this package, and is thrown as it is.
 */
export async function attempt<T>(
  call: () => Promise<unknown>,
  shape: (value: unknown) => value is T,
): Promise<Outcome<T>> {
  let value: unknown

  try {
    value = await call()
  } catch (error) {
    const failure = classify(error)

    if (failure === undefined) {
      throw error
    }

    return { ok: false, failure }
  }

  return shape(value) ? { ok: true, value } : { ok: false, failure: { kind: 'invalid-response' } }
}

function classify(error: unknown): Failure | undefined {
  if (error instanceof ErrFetchyHTTP) {
    return { kind: kindOf(error.status), status: error.status }
  }

  // What `AbortSignal.timeout(...)` aborts a call with.
  if (error instanceof Error && error.name === 'TimeoutError') {
    return { kind: 'timeout' }
  }

  // A body that is not JSON.
  if (error instanceof SyntaxError) {
    return { kind: 'invalid-response' }
  }

  // What `fetch` rejects with when the request never got an answer: the system error is its cause.
  if (error instanceof TypeError && error.cause !== undefined) {
    return { kind: 'unreachable', code: codeOf(error.cause) }
  }

  return undefined
}

function kindOf(status: number): FailureKind {
  switch (status) {
    case 401:
      return 'unauthorized'
    case 403:
      return 'forbidden'
    case 404:
      return 'not-found'
    default:
      return status >= 500 ? 'server-error' : 'http-error'
  }
}

// A connection to a host with several addresses fails with one error per address, gathered in an AggregateError.
function codeOf(cause: unknown): string | undefined {
  const { code, errors } = cause as { code?: unknown; errors?: unknown }

  if (typeof code === 'string') {
    return code
  }

  return Array.isArray(errors) && errors.length > 0 ? codeOf(errors[0]) : undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const arrays =
  <T>(...keys: string[]) =>
  (value: unknown): value is T =>
    isRecord(value) && keys.every(key => Array.isArray(value[key]))

export const isIndex = (value: unknown): value is DevToolsIndex =>
  arrays<DevToolsIndex>('slices')(value) && value.slices.every(slice => isRecord(slice) && typeof slice.id === 'string')
export const isBindings = arrays<DevToolsBindingsReport>('bindings')
export const isGraph = arrays<BindingGraph>('nodes', 'edges')
export const isRoutes = arrays<DevToolsRoutesReport>('groups')
export const isConfiguration = arrays<DevToolsConfigurationReport>('sources', 'entries')
export const isHealth = (value: unknown): value is DevToolsHealthReport =>
  isRecord(value) &&
  isRecord(value.availability) &&
  ['liveness', 'readiness', 'startup'].every(probe => isRecord(value[probe]))
export const isInfo = (value: unknown): value is DevToolsInfoReport =>
  isRecord(value) && typeof value.name === 'string' && isRecord(value.memory)
export const isAnything = (_value: unknown): _value is unknown => true
