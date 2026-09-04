#!/usr/bin/env bun

import { watch } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { run as generate } from './command/generate/index.js'
import { run as scaffold } from './command/scaffold/index.js'

interface CommandOpts {
  cwd: string
  config?: string
  flavor?: string
  arch?: string
  kind?: string
  name?: string
  agentsMd?: boolean
}

type CommandRunner = (opts: CommandOpts) => Promise<void>

const commands: Record<string, CommandRunner> = {
  generate,
  scaffold,
}

const aliases: Record<string, string> = {
  g: 'generate',
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    config: { type: 'string', short: 'c' },
    cwd: { type: 'string' },
    watch: { type: 'boolean', short: 'w', default: false },
    flavor: { type: 'string', short: 'f' },
    arch: { type: 'string', short: 'a' },
    'no-agents-md': { type: 'boolean', default: false },
  },
  allowPositionals: true,
})

const commandName = positionals[0] ?? ''
const command = commands[aliases[commandName] ?? commandName]

if (!command) {
  console.error('Usage: caffeine <command> [options]')
  console.error('Commands: generate (g), scaffold')
  process.exit(1)
}

const cwd = values.cwd ? resolve(values.cwd) : process.cwd()
const opts: CommandOpts = {
  cwd,
  config: values.config,
  flavor: values.flavor,
  arch: values.arch,
  kind: positionals[1],
  name: positionals[1],
  agentsMd: values['no-agents-md'] !== true,
}

async function runCommand(): Promise<void> {
  try {
    await command(opts)
  } catch (err) {
    console.error(`[caffeine] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

if (values.watch) {
  await runCommand()

  let debounce: ReturnType<typeof setTimeout> | undefined
  watch(cwd, { recursive: true }, (event, filename) => {
    if (!filename || event !== 'rename') {
      return
    }
    clearTimeout(debounce)
    debounce = setTimeout(() => {
      void runCommand()
    }, 50)
  })

  console.log('[caffeine] watching for file changes...')
} else {
  await runCommand()
}
