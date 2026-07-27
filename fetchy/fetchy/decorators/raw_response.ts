import { ErrFetchyInvalidDecoratorTarget } from '../errors.js'
import { NoopResponseHandler } from '../response_handler.js'
import { RawResponseConverter } from '../response_converter.js'
import { configureMethod } from './registrar/registrar.js'

/**
 * Opts a method (or field-declared operation) out of both response conversion and error handling:
 * it returns the raw `Response` object, and a non-ok status no longer throws `ErrFetchyHTTP` — the
 * caller inspects `.ok`/`.status` themselves. Combines `@UseResponseConverter(RawResponseConverter)`
 * and `@UseResponseHandler(NoopResponseHandler)` in one decorator.
 */
export function RawResponse() {
  return function (_value: unknown, context: ClassMethodDecoratorContext | ClassFieldDecoratorContext): void {
    if (context.kind !== 'method' && context.kind !== 'field') {
      throw new ErrFetchyInvalidDecoratorTarget('RawResponse', 'a method or field')
    }

    configureMethod(context, spec => {
      spec.responseConverter(RawResponseConverter)
      spec.responseHandler(NoopResponseHandler)
    })
  }
}
