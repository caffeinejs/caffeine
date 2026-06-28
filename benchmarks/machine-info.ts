import { execSync } from 'node:child_process'
import os from 'node:os'

export function printMachineInfo(opts?: { runtime?: 'node' | 'bun' }): void {
  const cpus = os.cpus()
  const cpu = cpus[0]
  const totalRam = (os.totalmem() / 1024 ** 3).toFixed(1)

  console.log('\nMachine:')
  console.log(`  OS:   ${os.type()} ${os.release()} ${os.arch()}`)
  console.log(`  CPU:  ${cpu.model.trim()} x${cpus.length} @ ${(cpu.speed / 1000).toFixed(2)} GHz`)
  console.log(`  RAM:  ${totalRam} GB`)
  console.log(`  Node: ${process.version}`)
  if (opts?.runtime === 'bun') {
    const bunVersion = execSync('bun --version', { encoding: 'utf8' }).trim()
    console.log(`  Bun:  ${bunVersion}`)
  }
}
