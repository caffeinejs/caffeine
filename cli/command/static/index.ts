import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import { errMessage } from '../../err_message.gen.js'

const usage = 'Usage: caffeine static <build|verify> --root DIR [--cwd PROJECT]'

export async function run(args: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args,
      options: { root: { type: 'string' }, cwd: { type: 'string' } },
      allowPositionals: true,
    })
  } catch {
    console.error(usage)
    return 2
  }

  const { positionals, values } = parsed
  const [command] = positionals
  if (positionals.length !== 1 || (command !== 'build' && command !== 'verify') || !values.root) {
    console.error(usage)
    return 2
  }

  const cwd = resolve(values.cwd ?? '.')
  let entry: string
  try {
    entry = Bun.resolveSync('@caffeinejs/static/build', cwd)
  } catch {
    console.error(
      errMessage(`Cannot resolve "@caffeinejs/static/build" from "${cwd}"`)
        .solutions('Install @caffeinejs/static in this project')
        .build(),
    )
    return 1
  }

  try {
    const { buildStatic, verifyStatic } = await import(pathToFileURL(entry).href)
    const operation = command === 'build' ? buildStatic : verifyStatic
    const { files, variants, bytes } = await operation({ root: resolve(cwd, values.root) })
    console.log(`${files} files, ${variants} variants, ${bytes} bytes`)
    return 0
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    return 1
  }
}
