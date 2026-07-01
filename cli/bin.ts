#!/usr/bin/env bun

import { watch } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { run as generate } from './command/generate/index.js'

type CommandRunner = (opts: { cwd: string, config?: string }) => Promise<void>

const commands: Record<string, CommandRunner> = {
  generate,
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    config: { type: 'string', short: 'c' },
    cwd: { type: 'string' },
    watch: { type: 'boolean', short: 'w', default: false },
  },
  allowPositionals: true,
})

const commandName = positionals[0] ?? ''
const command = commands[commandName]

if (!command) {
  console.error('Usage: caffeine <command> [options]')
  console.error(`Commands: ${Object.keys(commands).join(', ')}`)
  process.exit(1)
}

const cwd = values.cwd ? resolve(values.cwd) : process.cwd()
const opts = { cwd, config: values.config }

if (values.watch) {
  await command(opts)

  let debounce: ReturnType<typeof setTimeout> | undefined
  watch(cwd, { recursive: true }, (event, filename) => {
    if (!filename || event !== 'rename') {
      return
    }
    clearTimeout(debounce)
    debounce = setTimeout(() => {
      void command(opts)
    }, 50)
  })

  console.log('[caffeine] watching for file changes...')
} else {
  await command(opts)
}
