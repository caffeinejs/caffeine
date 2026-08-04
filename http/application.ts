import { Container } from '@caffeinejs/di'
import type { Router } from './route.js'
import { Feats } from './feats.js'
import { kServiceConfigure, Service, ServiceKit, Services } from './service.js'
import { buildRouting } from './routing/routing.js'
import { AuthenticationService } from './security/auth/service.js'
import { kAuthOpts, kOIDCMeta } from './security/auth/keys.js'
import type { OIDCMeta } from './security/auth/oidc/index.js'
import { ErrorHandlerProvider, ErrorHandlingServiceConfigurer } from './error/index.js'

export interface AdapterIn<R> {
  routers: Router<R>[]
  feats: Feats
  services: Services
}

export interface Adapter<I, R> {
  get instance(): I

  setup(input: AdapterIn<R>): Promise<void>
  teardown(): Promise<void>
  fetch(request: Request | string | URL, options?: RequestInit): Promise<Response>
}

export interface AdapterFactoryIn {
  container: Container
}

export type AdapterFactory<I, REQ, A extends Adapter<I, REQ> = Adapter<I, REQ>>
  = (input: AdapterFactoryIn) => A

export class WebApplication<I, R, A extends Adapter<I, R> = Adapter<I, R>> {
  #container: Container
  #feats: Feats
  #routers: Router<R>[] = []
  #services: Service[]
  #adapter: A
  #ready: boolean = false
  #readyHooks: Array<() => Promise<void>> = []
  #closeHooks: Array<() => Promise<void>> = []

  constructor(container: Container, adapter: A, services: Service[]) {
    this.#container = container
    this.#adapter = adapter
    this.#feats = new Feats()
    this.#services = services
  }

  get container(): Container {
    return this.#container
  }

  get instance(): I {
    return this.#adapter.instance
  }

  get routers(): Router<R>[] {
    if (!this.#ready) {
      throw new Error('Application is not ready')
    }

    return this.#routers
  }

  fetch(request: Request | string | URL, options?: RequestInit): Promise<Response> {
    return this.#adapter.fetch(request, options)
  }

  async ready(): Promise<void> {
    const kit: ServiceKit = { container: this.#container, feats: this.#feats }
    const configurers = [...this.#services, new ErrorHandlingServiceConfigurer()]

    await Promise
      .all(configurers
        .map(service => service[kServiceConfigure](kit)))

    await this.#container.init()

    this.#routers = buildRouting<R>(this.#container)

    const services: Services = {
      auth: {
        enabled: this.#feats.authentication,
        coordinator: this.#container.getOptional(AuthenticationService),
        options: this.#container.getOptional(kAuthOpts),
      },
      oidc: this.#container.getOptional<OIDCMeta>(kOIDCMeta),
      errorHandling: this.#container.get(ErrorHandlerProvider),
    }

    await this.#adapter.setup({ routers: this.#routers, feats: this.#feats, services })

    for (const hook of this.#readyHooks) {
      await hook()
    }

    this.#ready = true
  }

  async close(): Promise<void> {
    for (const hook of this.#closeHooks) {
      await hook()
    }

    await this.#adapter.teardown()
    await this.#container.dispose()
  }

  onReady(hook: () => Promise<void>): this {
    this.#readyHooks.push(hook)
    return this
  }

  onClose(hook: () => Promise<void>): this {
    this.#closeHooks.push(hook)
    return this
  }
}
