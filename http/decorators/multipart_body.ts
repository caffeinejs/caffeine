import type { MultipartLimits } from '../core/multipart/limits.js'
import type { RouteExtension } from '../core/routing/extension.js'
import { configureRoute } from './registrar/registrar.js'

/**
 * Declares a multipart request body for this route. The default subtype is `form-data`;
 * pass `*` to accept any multipart subtype. Each specified limit overrides the server setting.
 */
export function multipartBody(subtype = 'form-data', limits?: MultipartLimits): RouteExtension {
  return route => route.multipart({ subtype, limits })
}

/** Declares a controller method's multipart request body. See {@link multipartBody}. */
export function MultipartBodyInput(subtype = 'form-data', limits?: MultipartLimits) {
  const configure = multipartBody(subtype, limits)
  return (_target: Function, context: ClassMemberDecoratorContext): void => {
    configureRoute(context, configure)
  }
}
