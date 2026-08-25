import { AllowAnonymous, Controller, Get } from '@caffeinejs/http'
import { APIGroup } from '@caffeinejs/openapi'
import { View } from '@caffeinejs/view'
import { githubConfigured } from '../auth/index.js'

// Landing page for the Petstore API. Public, HTML — a human-facing index of the API's authentication
// strategies (GitHub sign-in, and Basic for the docs). Rendered from a Handlebars template
// (src/views/home.hbs) via the framework's view feature.
// Hidden from the OpenAPI document: this renders a browser page, and an API description is not the place
// for it. Nothing about the route changes — only whether the document mentions it.
@APIGroup({ hidden: true })
@Controller('/')
export class HomeController {
  @Get('/')
  @AllowAnonymous()
  home() {
    return View('home', { githubConfigured, title: 'Petstore API' })
  }
}
