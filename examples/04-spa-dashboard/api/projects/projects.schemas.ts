import { $t } from '@caffeinejs/std/schema'

export const ProjectSchema = $t.Object({
  id: $t.String(),
  name: $t.String(),
  status: $t.Union([$t.Literal('active'), $t.Literal('paused'), $t.Literal('done')]),
  owner: $t.String(),
})

export const ProjectListSchema = $t.Object({
  projects: $t.Array(ProjectSchema),
})

export const ProjectIdParamSchema = $t.Object({
  id: $t.String(),
})
