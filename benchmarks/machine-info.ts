import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Read from disk rather than resolved: several of these packages do not export their package.json.
function installedVersion(pkg: string): string {
  for (const root of [__dirname, resolve(__dirname, '..')]) {
    try {
      const manifest = JSON.parse(readFileSync(resolve(root, 'node_modules', pkg, 'package.json'), 'utf8')) as {
        version: string
      }
      return manifest.version
    } catch {
      // not installed at this level
    }
  }
  return 'not found'
}

export function printVersions(packages: string[]): void {
  if (packages.length === 0) {
    return
  }
  console.log('\nVersions:')
  const width = Math.max(...packages.map(p => p.length))
  for (const pkg of packages) {
    console.log(`  ${pkg.padEnd(width)}  ${installedVersion(pkg)}`)
  }
}

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
