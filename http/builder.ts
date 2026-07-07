import { CaffeineIoC, type Container, type Module, type Options } from '@caffeinejs/core'
import { CaffeineError, Keys } from '@caffeinejs/application'
import { AdapterFactory, WebApplication, type Adapter } from './application.js'
import type { Router } from './route.js'
import { AuthenticationBuilder } from './security/auth/builder.js'
import { AuthorizationBuilder } from './security/authz/builder.js'
import { AssertionHandler, AuthenticatedUserHandler, ClaimHandler, RoleHandler } from './security/authz/handlers.js'
import { getRouter } from './decorators/registrar/registrar.js'
import { AuthzRequirement, AuthzRequirementHandler, compileRoutePolicy } from './security/authz/policy.js'

export type WebApplicationOptions = {
  container?: Container | Options
}

export class WebApplicationBuilder<I, REQ, A extends Adapter<I, REQ> = Adapter<I, REQ>> {
  readonly #adapterFactory: AdapterFactory<I, REQ, A>
  readonly #container: Container
  #authBuilder: AuthenticationBuilder | undefined
  #authzBuilder: AuthorizationBuilder | undefined

  constructor(adapterFactory: AdapterFactory<I, REQ, A>, options: WebApplicationOptions = {}) {
    const c = options.container
    this.#container = c != null && typeof (c as Container).get === 'function'
      ? c as Container
      : new CaffeineIoC(c != null ? c as Partial<Options> : {})
    this.#adapterFactory = adapterFactory
  }

  get authentication(): AuthenticationBuilder {
    this.#authBuilder ??= new AuthenticationBuilder(this.#container)
    return this.#authBuilder
  }

  get authorization(): AuthorizationBuilder {
    this.#authzBuilder ??= new AuthorizationBuilder()
    return this.#authzBuilder
  }

  addModules(module: Module, ...modules: Module[]): this {
    this.#container.addModules(module, ...modules)
    return this
  }

  build(): WebApplication<I, REQ, A> {
    const authResult = this.#authBuilder?.build()

    if (this.#authBuilder != null && this.#authzBuilder == null) {
      this.#authzBuilder = new AuthorizationBuilder()
    }

    const builtInHandlers: AuthzRequirementHandler<AuthzRequirement>[] = [
      new AuthenticatedUserHandler(),
      new RoleHandler(),
      new ClaimHandler(),
      new AssertionHandler(),
    ]

    const authzResult = this.#authzBuilder?.build(this.#container, builtInHandlers)

    const container = this.#container
    const authCoordinator = authResult?.coordinator
    const authOptions = authResult?.options

    const hasAuthz = this.#authzBuilder != null
    const authzEvaluators = authzResult?.evaluators
    const authzHandlers = authzResult?.handlers
    const authzOptions = authzResult?.options

    const adapter = this.#adapterFactory({
      container,
      authentication: {
        enabled: this.#authBuilder != null,
        coordinator: authCoordinator,
        options: authOptions,
      },
      authorization: {
        enabled: this.#authzBuilder != null,
      },
    })

    const controllers = container.getBindingsByLabel(Keys.CONTROLLER)
    const routers = new Array<Router<REQ>>(controllers.length)

    for (let i = 0; i < controllers.length; i++) {
      const { key, binding } = controllers[i]
      const rd = getRouter(key as Function)
      if (!rd) {
        throw new CaffeineError(
          `Cannot build router: no route definition found for router "${String(key)}"`,
          'HTTP_MISSING_ROUTER',
        )
      }

      const router = rd.toRouter<REQ>()

      routers[i] = {
        path: router.path,
        prefix: router.prefix,
        key,
        binding,
        controller: container.wrap(key),
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
                enabled: hasAuthz,
                hasProtection: hasDecoratorProtection && !isAnonymous,
                options: route.authz,
                authorizer: hasAuthz && hasDecoratorProtection
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

    return new WebApplication(container, routers, adapter)
  }
}

export function createWebApplication<I, REQ, A extends Adapter<I, REQ> = Adapter<I, REQ>>(
  adapterFactory: AdapterFactory<I, REQ, A>,
  options: WebApplicationOptions = {},
): WebApplicationBuilder<I, REQ, A> {
  return new WebApplicationBuilder(adapterFactory, options)
}
