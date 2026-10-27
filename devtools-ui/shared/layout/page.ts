import { HTML } from '@caffeinejs/html'
import type { Children } from '@kitajs/html'

import type { DevToolsAPI } from '../../api.js'
import type { Config } from '../../app.config.js'
import { Layout } from './Layout.js'

/** What a page renders into the layout: its title, its path and its body. */
export interface PageContent {
  readonly title: string
  readonly active: string
  readonly scripts?: readonly string[]
  readonly body: Children
}

/** Renders a page inside the layout, its navigation read from the devtools index. */
export async function page(api: DevToolsAPI, config: Config, content: PageContent): Promise<ReturnType<typeof HTML>> {
  const { tools } = await api.index()

  return HTML(
    Layout({
      title: content.title,
      tools,
      target: config.target.url,
      active: content.active,
      scripts: content.scripts,
      children: content.body,
    }),
  )
}
