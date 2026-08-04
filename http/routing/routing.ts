import { Container, Ctor } from '@caffeinejs/di'
import { ErrCaffeineWebApplication, ErrConfiguration } from '../error/index.js'
import { solutions } from '../error/util.js'
import { Keys } from '../symbols.js'
import { Router } from '../route.js'
import { AuthorizationOptions, AuthzRequirement, AuthzRequirementHandler, compileRoutePolicy, kAuthzEvaluators, kAuthzHandlers, kAuthzOpts, PolicyEvaluator } from '../security/authz/index.js'
import { Feats } from '../feats.js'
import { getRouter } from '../decorators/registrar/index.js'

export function buildRouting<REQ>(container: Container, feats: Feats): Router<REQ>[] {
  let authzEvaluators: Map<string, PolicyEvaluator> | undefined
  let authzHandlers: Map<string, AuthzRequirementHandler<AuthzRequirement>> | undefined
  let authzOptions: AuthorizationOptions | undefined

  if (feats.authorization) {
    authzEvaluators = container.get(kAuthzEvaluators)
    authzHandlers = container.get(kAuthzHandlers)
    authzOptions = container.get(kAuthzOpts)
  }

  const controllers = container.getBindingsByLabel(Keys.CONTROLLER)
  const routers = new Array<Router<REQ>>(controllers.length)

  for (let i = 0; i < controllers.length; i++) {
    const { key, binding } = controllers[i]
    const rd = getRouter(key as Function)
    if (!rd) {
      throw new ErrCaffeineWebApplication(
        `Cannot build router: no route definition found for router "${String(key)}"`,
        'ERR_HTTP_MISSING_ROUTER',
      )
    }

    const router = rd.toRouter<REQ>()

    routers[i] = {
      path: router.path,
      prefix: router.prefix,
      key,
      binding,
      controller: container.wrap(key),
      errorHandlers: buildErrorHandlerMap(router.errorHandlers, key, new Set(router.routes.map(r => r.handler))),
      routes: router.routes.map(route => {
        const config = new Map<string, unknown>()
        if (router.config) {
          for (const [k, v] of router.config) {
            config.set(k, v)
          }
        }
        if (route.config) {
          for (const [k, v] of route.config) {
            config.set(k, v)
          }
        }

        // Route Options
        // https://fastify.dev/docs/latest/Reference/Routes/#routes-options
        const options = new Map<string, unknown>()
        if (router.options) {
          for (const [k, v] of router.options) {
            options.set(k, v)
          }
        }
        if (route.options) {
          for (const [k, v] of route.options) {
            options.set(k, v)
          }
        }

        const header = new Map<string, string | string[]>()
        if (router.header) {
          for (const [k, v] of router.header) {
            header.set(k, v)
          }
        }
        if (route.header) {
          for (const [k, v] of route.header) {
            header.set(k, v)
          }
        }
        const hasHeader = !!router.header || !!route.header

        return {
          path: route.path,
          method: route.method,
          accept: route.accept ?? router.accept,
          contentType: route.contentType ?? router.contentType,
          parameters: route.parameters,
          handler: route.handler,
          schema: route.schema,
          bodyLimit: route.bodyLimit ?? router.bodyLimit,
          timeout: route.timeout ?? router.timeout,
          header,
          hasHeader,
          statusCode: route.statusCode,
          config: config,
          options: options,
          extras: route.extras,
          authorization: (() => {
            const hasDecoratorProtection = router.authz !== undefined || route.authz !== undefined
            const isAnonymous = !!(router.authz?.allowAnonymous || route.authz?.allowAnonymous)

            return {
              enabled: feats.authorization,
              hasProtection: hasDecoratorProtection && !isAnonymous,
              options: route.authz,
              authorizer: feats.authorization && hasDecoratorProtection
                ? compileRoutePolicy(
                    authzOptions!,
                    authzEvaluators!,
                    authzHandlers!,
                    router.authz,
                    route.authz,
                  )
                : undefined,
            }
          })(),
        }
      }),
    }
  }

  return routers
}

// Converts the raw per-controller error-handler list into a lookup map, rejecting two handlers for
// the same error type. Runs at build (app.ready()), so the throw is observable, not an import crash.
function buildErrorHandlerMap(
  handlers: Array<[Ctor<Error>, string | symbol]> | undefined,
  controllerKey: unknown,
  routeHandlers: Set<string | symbol>,
): Map<Ctor<Error>, string | symbol> | undefined {
  if (!handlers?.length) {
    return undefined
  }

  const map = new Map<Ctor<Error>, string | symbol>()
  for (const [errorType, methodKey] of handlers) {
    if (routeHandlers.has(methodKey)) {
      throw new ErrConfiguration(
        `Method "${String(methodKey)}" in "${String(controllerKey)}" cannot be both a route and an error handler`
        + solutions(`Move the "@Catch(${errorType.name})" handler to a method without a route verb decorator`),
      )
    }

    if (map.has(errorType)) {
      throw new ErrConfiguration(
        `Ambiguous controller error handler: multiple handlers registered for "${errorType.name}" in "${String(controllerKey)}"`
        + solutions(`Keep a single "@Catch(${errorType.name})" method per controller`),
      )
    }

    map.set(errorType, methodKey)
  }

  return map
}
