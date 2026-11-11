import { fileURLToPath } from 'node:url'

import { buildStatic } from '@caffeinejs/static/build'

/** Builds `public/` before the suite: the pages link its stylesheet and scripts, served from the manifest. */
export default async function setup(): Promise<void> {
  await buildStatic({ root: fileURLToPath(new URL('../public', import.meta.url)) })
}
