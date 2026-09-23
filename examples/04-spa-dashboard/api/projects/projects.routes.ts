import { ErrHTTPNotFound, newRouter } from '@caffeinejs/http'
import { apiGroup, operation } from '@caffeinejs/openapi'

import { ProjectIdParamSchema, ProjectListSchema, ProjectSchema } from './projects.schemas.js'

/** Static data: this example is about serving a single-page application, not about storage. */
const PROJECTS = [
  { id: 'roast', name: 'Roast profiles', status: 'active', owner: 'Ada Admin' },
  { id: 'grind', name: 'Grind calibration', status: 'paused', owner: 'Ulric User' },
  { id: 'brew', name: 'Brew ratios', status: 'done', owner: 'Ada Admin' },
] as const

/**
 * Projects, declared as a router rather than a controller — the example's second route source.
 *
 * It compiles through exactly the same path a `@Controller` does, so it is authorized, validated and
 * documented identically; `apiGroup()` and `operation()` are the functions the decorators call. The one thing
 * worth noticing is what it is *not*: there is no catch-all here. `/api/*` in `spa/pages.ts` covers a miss
 * under this base and under both controllers, which is why it stays one line however many of these there are.
 */
const projects = newRouter('/api/projects')
  .name('Projects')
  .with(apiGroup({ name: 'Projects', description: 'The signed-in user’s projects.' }))
  // Bare, so it asks for the application's default policy — an authenticated caller.
  .authorize({})

export const projectsRouter = projects
  .get('/')
  .schema({ response: { 200: ProjectListSchema } })
  .with(operation({ operationId: 'listProjects', summary: 'List every project' }))
  .handler(() => ({ projects: PROJECTS.map(project => ({ ...project })) }))

  .get('/:id')
  .schema({ params: ProjectIdParamSchema, response: { 200: ProjectSchema } })
  .with(operation({ operationId: 'getProject', summary: 'One project by id' }))
  .handler(ctx => {
    const { id } = ctx.req.param()
    const project = PROJECTS.find(candidate => candidate.id === id)

    if (project === undefined) {
      throw new ErrHTTPNotFound(`No project with id "${id}"`)
    }

    return { ...project }
  })
