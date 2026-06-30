#!/usr/bin/env bun

import { watch } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { loadConfig } from './config.js'
import { generate } from './generator.js'
import { generateModules } from './modules_generator.js'
import { scan } from './scanner.js'

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    config: { type: 'string', short: 'c' },
    cwd: { type: 'string' },
    watch: { type: 'boolean', short: 'w', default: false },
  },
  allowPositionals: true,
})

const command = positionals[0]

if (command !== 'generate') {
  console.error('Usage: caffeine generate [--config <path>] [--cwd <dir>] [--watch]')
  process.exit(1)
}

const cwd = values.cwd ? resolve(values.cwd) : process.cwd()

async function run(): Promise<void> {
  const config = await loadConfig(cwd, values.config)

  if (!config.generate && !config.modules) {
    console.error('[caffeine] config must define at least one of: generate, modules')
    process.exit(1)
  }

  const allOutputs = [
    config.generate?.output,
    config.modules?.output ?? 'app.mod.ts',
  ].filter((o): o is string => o !== undefined)

  if (config.generate) {
    const { include, exclude = [], output, importExtension = '.js' } = config.generate
    const outputPath = resolve(cwd, output)
    const files = await scan({ root: cwd, include, exclude: [...exclude, ...allOutputs] })
    const changed = await generate({ files, output: outputPath, importExtension })

    if (changed) {
      console.log('[caffeine] generated', output, `(${files.length} files)`)
    } else {
      console.log('[caffeine] up to date', output)
    }
  }

  if (config.modules) {
    const { include, exclude = [], output = 'app.mod.ts', importExtension = '.js' } = config.modules
    const outputPath = resolve(cwd, output)
    const files = await scan({ root: cwd, include, exclude: [...exclude, ...allOutputs] })
    const changed = await generateModules({ files, output: outputPath, importExtension })

    if (changed) {
      console.log('[caffeine] generated modules', output, `(${files.length} files)`)
    } else {
      console.log('[caffeine] up to date modules', output)
    }
  }
}

if (values.watch) {
  await run()

  let debounce: ReturnType<typeof setTimeout> | undefined
  watch(cwd, { recursive: true }, (event, filename) => {
    if (!filename || event !== 'rename') {
      return
    }
    clearTimeout(debounce)
    debounce = setTimeout(() => {
      void run()
    }, 50)
  })

  console.log('[caffeine] watching for file changes...')
} else {
  await run()
}
