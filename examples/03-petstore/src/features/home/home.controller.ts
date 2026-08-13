import { AllowAnonymous, Controller, Get, View } from '@caffeinejs/http'
import { githubConfigured } from '../auth/index.js'

// Landing page for the Petstore API. Public, HTML — a human-facing index of the API's authentication
// strategies (GitHub sign-in and the JWT token endpoint). Rendered from a Handlebars template
// (src/views/home.hbs) via the framework's view feature.
@Controller('/')
export class HomeController {
  @Get('/')
  @AllowAnonymous()
  home() {
    return View('home', { githubConfigured, title: 'Petstore API' })
  }
}
