#!/usr/bin/env bun
import { watch } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { loadConfig } from './config.js'
import { generate } from './generator.js'
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
  const { include, exclude = [], output, importExtension = '.js' } = config.generate

  const outputPath = resolve(cwd, output)
  const files = await scan({ root: cwd, include, exclude: [...exclude, output] })
  const changed = await generate({ files, output: outputPath, importExtension })

  if (changed) {
    console.log('[caffeine] generated', output, `(${files.length} files)`)
  } else {
    console.log('[caffeine] up to date', output)
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
