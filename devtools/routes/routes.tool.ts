import type { Container } from '@caffeinejs/di'
import { AuthenticationSchemeProvider, kAuthzOpts, RouteInventory } from '@caffeinejs/http'

import type { ToolInfo } from '../tool.js'
import type { SecurityRecord, ServerRoutesRecord } from './routes.schema.js'

export const routesTool: ToolInfo = {
  id: 'routes',
  title: 'Routes',
  description: 'Every route of every server, and what each one requires',
}

/** Reads every server's routes and what protects them, as the application registered them. */
export class RoutesTool {
  readonly #container: Container

  constructor(container: Container) {
    this.#container = container
  }

  /** Every server's routes, or only those of the server `only` names: `''` for the application's own. */
  servers(only: string | undefined): ServerRoutesRecord[] {
    return only === undefined ? this.#servers() : this.#servers().filter(entry => entry.server === only)
  }

  security(): SecurityRecord {
    const schemes = this.#container.getOptional(AuthenticationSchemeProvider)
    const authz = this.#container.getOptional(kAuthzOpts)

    return {
      authentication: {
        schemes: [...(schemes?.schemeNames ?? [])],
        defaultScheme: schemes?.defaultAuthenticateScheme || undefined,
      },
      authorization: {
        fallbackPolicy: authz?.fallbackPolicy?.name,
        fallbackExcept: [...(authz?.fallbackExcept ?? [])],
        defaultPolicy: authz?.authorizeDecoratorDefaultPolicy.name,
      },
      gates: this.#servers().map(entry => ({
        server: entry.server,
        gates: [...new Set(entry.routes.flatMap(route => route.security.authentication.gate ?? []))],
      })),
    }
  }

  #servers(): ServerRoutesRecord[] {
    return this.#container
      .get(RouteInventory)
      .servers.map(entry => ({ ...entry, server: entry.server ?? '' }) as ServerRoutesRecord)
  }
}
