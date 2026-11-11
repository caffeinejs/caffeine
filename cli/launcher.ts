#!/usr/bin/env node
// The `caffeine` bin: runs the binary for this platform with the same arguments, and ends the way it ends.
import { type ChildProcess, spawn } from 'node:child_process'
import { constants } from 'node:os'

import { resolveBinary } from './binary.js'

function fail(message: string): never {
  console.error(`[caffeine] ${message}`)
  process.exit(1)
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

let binary: string
try {
  binary = resolveBinary()
} catch (err) {
  fail(reason(err))
}

// A terminal sends SIGINT and SIGHUP to its whole foreground group, the binary included, so this process only
// outlives them: passed on, each would reach the binary twice. A SIGTERM is sent to this process alone, as a process
// manager sends it, so it is passed on. The handlers go in before the spawn: a signal that arrives in between waits
// for this script to finish, and finds the binary running.
process.on('SIGINT', outlive)
process.on('SIGHUP', outlive)
process.on('SIGTERM', forward)

let child: ChildProcess
try {
  child = spawn(binary, process.argv.slice(2), { stdio: 'inherit' })
} catch (err) {
  // spawn throws the errors it does not expect, such as ENOEXEC for a binary built for another platform.
  fail(`Cannot run "${binary}": ${reason(err)}`)
}

function outlive(): void {
  // The binary has the signal from the terminal already, and this process ends when it does.
}

function forward(signal: NodeJS.Signals): void {
  child.kill(signal)
}

function stopListening(): void {
  process.off('SIGINT', outlive)
  process.off('SIGHUP', outlive)
  process.off('SIGTERM', forward)
}

child.on('error', err => {
  stopListening()
  fail(`Cannot run "${binary}": ${err.message}`)
})

child.on('exit', (code, signal) => {
  stopListening()
  if (signal === null) {
    process.exitCode = code ?? 1
    return
  }

  // Ends this process the same way, but for SIGUSR1, on which Node opens its inspector instead. Node does not end on
  // SIGPIPE either: either way the code tells the failure apart from success.
  process.exitCode = 128 + constants.signals[signal]
  if (signal !== 'SIGUSR1') {
    process.kill(process.pid, signal)
  }
})
