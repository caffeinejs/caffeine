import { HTML } from '@caffeinejs/html'
import { AllowAnonymous, Controller, Get } from '@caffeinejs/http'
import { APIGroup } from '@caffeinejs/openapi'

import { type Config, githubConfigured, kConfig } from '../app.config.js'
import { Home } from './html/Home.js'

// Landing page for the Petstore API. Public, HTML — a human-facing index of the API's authentication
// strategies (GitHub sign-in, and Basic for the docs). Rendered by a JSX component; `@kitajs/html` has no
// render step, so `Home(...)` already is the markup.
// Hidden from the OpenAPI document: this renders a browser page, and an API description is not the place
// for it. Nothing about the route changes — only whether the document mentions it.
@APIGroup({ hidden: true })
@Controller('/', [kConfig])
export class HomeController {
  constructor(private readonly config: Config) {}

  @Get('/')
  @AllowAnonymous()
  home() {
    return HTML(Home({ githubConfigured: githubConfigured(this.config) }))
  }
}
