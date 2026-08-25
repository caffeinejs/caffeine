import { describe, it, expect } from 'vitest'
import { CaffeineIoC } from '@caffeinejs/di'
import fastify from 'fastify'
import {
  Controller,
  FeatureConfigurer,
  Get,
  type RouterPhaseContext,
  createWebApplication,
  fastifyAdapterFactory,
} from './index.js'

const SECRET = 'a-very-long-test-secret-key-32-bytes!'

@Controller('/ping')
class PingController {
  @Get('/')
  ping() {
    return { ok: true }
  }
}
void [PingController]

// A DI-discovered configurer that records which phases ran and whether its request hook — registered
// after `authentication` — sees `req.user` already populated.
class RecorderConfigurer extends FeatureConfigurer {
  readonly name = 'recorder'
  readonly after = ['authentication']
  readonly before = ['authorization']
  readonly phases: string[] = []
  userWasSet: boolean | undefined

  configureServer = (): void => {
    this.phases.push('server')
  }

  configureRouter = (ctx: RouterPhaseContext): void => {
    this.phases.push('router')
    ctx.server.addHook('onRequest', async req => {
      this.userWasSet = req.user != null
    })
  }

  configureRoute = (): void => {
    this.phases.push('route')
  }
}

async function buildApp(recorder: RecorderConfigurer) {
  const container = new CaffeineIoC()
  container.bind(RecorderConfigurer).toValue(recorder).extends()
  const builder = createWebApplication(fastifyAdapterFactory(fastify()), { container })
  builder.authentication(a => a.addJWTBearer(o => o.secret(SECRET).allowAnyIssuer().allowAnyAudience()))
  const app = builder.build()
  await app.ready()
  return app
}

describe('FeatureConfigurer discovery (application)', () => {
  it('runs a container-bound configurer at every phase', async () => {
    const recorder = new RecorderConfigurer()
    await buildApp(recorder)
    expect(recorder.phases).toEqual(['server', 'router', 'route'])
  })

  it('honours after:authentication — its request hook sees req.user set by the auth hook', async () => {
    const recorder = new RecorderConfigurer()
    const app = await buildApp(recorder)

    const res = await app.fetch('/ping')
    expect(res.status).toBe(200)
    // If the recorder hook had run before authentication, req.user would still be the decorated null.
    expect(recorder.userWasSet).toBe(true)
  })
})
