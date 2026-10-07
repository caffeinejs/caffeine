import type { CallAdapterFactory } from './call_adapter.js'
import { ChainExecutor } from './chain.js'
import type { MethodSpec } from './decorators/registrar/index.js'
import { ErrFetchyInvalidRoute } from './errors.js'
import type { Interceptor } from './interceptor.js'
import type { FetchyRequest } from './request.js'
import { RequestBuilder } from './request_builder.js'
import type { FetchyResponse } from './response.js'
import type { ResponseConverter } from './response_converter.js'
import { DefaultResponseHandler } from './response_handler.js'
import type { Transport } from './transport.js'

export interface InvokerContext {
  baseURL: string
  transport: Transport
  interceptors: readonly Interceptor[]
  responseConverter: ResponseConverter
  callAdapterFactories: readonly CallAdapterFactory[]
}

function terminalInterceptor(transport: Transport): Interceptor {
  return {
    intercept(chain) {
      return transport.send(chain.request())
    },
  }
}

/**
 * Performs one operation for one client: it takes the call's arguments as a single array.
 */
export type Invoker = (args: readonly unknown[]) => unknown

/**
 * Wires one operation's request builder, interceptor chain, response handler and response
 * converter, and the call adapter that applies to it, into one {@link Invoker}.
 *
 * @param label - Names the operation in an error, e.g. `UsersAPI.getUser`
 * @throws {@link ErrFetchyInvalidRoute} when the operation's call adapter does not return a function.
 */
export function buildInvoker(context: InvokerContext, meta: MethodSpec, label = meta.name): Invoker {
  const requestBuilder = new RequestBuilder(context.baseURL, meta)
  const responseHandler = meta.responseHandler ?? new DefaultResponseHandler(context.responseConverter)
  // The default handler passes an ok response through untouched, so awaiting it would only cost a promise and a tick.
  const handlesOk = meta.responseHandler !== undefined
  const interceptors = [...context.interceptors, terminalInterceptor(context.transport)]
  const send: (request: FetchyRequest) => Promise<FetchyResponse> =
    context.interceptors.length === 0
      ? request => context.transport.send(request)
      : request => ChainExecutor.first(interceptors, request, meta).proceed(request)

  const invoke = async (args: readonly unknown[]): Promise<unknown> => {
    const request = requestBuilder.toRequest(args)
    const response = await send(request)
    const handled = handlesOk || !response.ok ? await responseHandler.handle(request, response) : response
    // Awaited, not returned: an async function resolving its promise with another promise costs an extra job.
    const value = await context.responseConverter.convert(handled)
    return value
  }

  for (const factory of context.callAdapterFactories) {
    const adapter = factory.provide(meta)

    if (adapter) {
      const adapted: unknown = adapter.adapt((...args: unknown[]) => invoke(args))

      if (typeof adapted !== 'function') {
        throw new ErrFetchyInvalidRoute(label, 'its call adapter did not return a function')
      }

      return args => (adapted as (...args: unknown[]) => unknown)(...args)
    }
  }

  return invoke
}
