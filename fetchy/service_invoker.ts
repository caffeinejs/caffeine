import type { Call } from './call.js'
import type { CallAdapterFactory } from './call_adapter.js'
import { ChainExecutor } from './chain.js'
import type { Interceptor } from './interceptor.js'
import type { MethodSpec } from './decorators/registrar/index.js'
import { RequestBuilder } from './request_builder.js'
import type { ResponseConverter } from './response_converter.js'
import { DefaultResponseHandler } from './response_handler.js'

export interface InvokerContext {
  baseURL: string
  call: Call
  interceptors: readonly Interceptor[]
  responseConverter: ResponseConverter
  errorResponseConverter: ResponseConverter
  callAdapterFactories: readonly CallAdapterFactory[]
}

function terminalInterceptor(call: Call): Interceptor {
  return {
    intercept(chain) {
      return call.execute(chain.request())
    },
  }
}

/**
 * Wires a single decorated method's request builder, interceptor chain, response handler and
 * response converter into the function `FetchyClient.create()` assigns onto the created instance.
 */
export function buildInvoker(context: InvokerContext, meta: MethodSpec): (...args: unknown[]) => unknown {
  const requestBuilder = new RequestBuilder(context.baseURL, meta)
  const responseHandler = new DefaultResponseHandler(context.errorResponseConverter)
  const interceptors = [...context.interceptors, terminalInterceptor(context.call)]

  const invoke = async (...args: unknown[]): Promise<unknown> => {
    const request = requestBuilder.toRequest(args)
    const response = await ChainExecutor.first(interceptors, request).proceed(request)
    const handled = await responseHandler.handle(request, response)
    return context.responseConverter.convert(handled)
  }

  for (const factory of context.callAdapterFactories) {
    const adapter = factory.provide(meta)

    if (adapter) {
      return adapter.adapt(invoke) as (...args: unknown[]) => unknown
    }
  }

  return invoke
}
