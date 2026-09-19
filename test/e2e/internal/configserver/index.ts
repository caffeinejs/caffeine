import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'

/**
 * Helpers to drive the Spring Cloud Config Server (test/services/configserver) from the configuration e2e specs.
 * Its docker-compose file mounts the runtime directory below as a search location, so a spec writes its own
 * application's YAML there, and edits it while an application polls.
 */

export const CONFIG_SERVER = 'http://localhost:8888'
export const CONFIG_SERVER_AUTH = { username: 'configuser', password: 'configpass' }

const RUNTIME_DIR = new URL('../../../services/configserver/runtime/', import.meta.url)

export async function writeServerFile(name: string, yaml: string): Promise<void> {
  await writeFile(new URL(name, RUNTIME_DIR), yaml)
}

export async function removeServerFiles(...names: string[]): Promise<void> {
  await Promise.all(names.map(name => rm(new URL(name, RUNTIME_DIR), { force: true })))
}

/**
 * True when the server is up and serves what a spec writes into its runtime directory; specs skip when it is not.
 * A server started without the mount answers its health check but never sees the file, and is reported as down.
 */
export async function configServerServesRuntime(): Promise<boolean> {
  try {
    const health = await fetch(`${CONFIG_SERVER}/actuator/health`, { signal: AbortSignal.timeout(2000) })
    if (!health.ok) {
      return false
    }
  } catch {
    return false
  }

  const probe = randomUUID()
  await writeServerFile('e2e-probe.yml', `probe: '${probe}'\n`)

  try {
    const { username, password } = CONFIG_SERVER_AUTH
    const response = await fetch(`${CONFIG_SERVER}/e2e-probe/default`, {
      headers: { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` },
      signal: AbortSignal.timeout(2000),
    })
    if (!response.ok) {
      return false
    }

    const body = (await response.json()) as { propertySources?: { source: Record<string, unknown> }[] }
    return (body.propertySources ?? []).some(source => source.source['probe'] === probe)
  } catch {
    return false
  } finally {
    await removeServerFiles('e2e-probe.yml')
  }
}
