// A lock service in a process of its own, driven over IPC by `cluster.ts`, so a spec can stop and resume a
// holder the way an operating system or an orchestrator would.
import { createApplication } from '@caffeinejs/application'
import { CaffeineIoC } from '@caffeinejs/di'
import { DistributedLock, kDistLock, type Lock } from '@caffeinejs/distlock'
import { RedisLockBackend } from '@caffeinejs/distlock/backend/redis'
import { createClient } from '@redis/client'

import { fencedWrite } from './fenced_resource.js'

export type WorkerRequest =
  | { op: 'tryAcquire'; id: number; key: string; ttl: number; renew: boolean }
  | { op: 'write'; id: number; key: string; value: string }
  | { op: 'status'; id: number; key: string }
  | { op: 'release'; id: number; key: string }
  | { op: 'close'; id: number }

export interface WorkerReply {
  id: number
  acquired?: boolean
  fencingToken?: number
  accepted?: boolean
  lost?: boolean
  signalReason?: { code: string; reason?: string }
  error?: string
}

const url = process.env.DISTLOCK_URL
if (url === undefined) {
  throw new Error('Cannot start the distlock worker: DISTLOCK_URL is not set')
}

const client = createClient({ url })
await client.connect()

const app = createApplication({ container: new CaffeineIoC({ decorators: false }) }).install(
  DistributedLock(d => d.backend(new RedisLockBackend(client))),
)
await app.bootstrap()
const lock = app.container.get(kDistLock)

const held = new Map<string, Lock>()

function heldLock(key: string): Lock {
  const acquired = held.get(key)
  if (acquired === undefined) {
    throw new Error(`Cannot find a lock on "${key}" in this worker: acquire it first`)
  }

  return acquired
}

async function handle(request: WorkerRequest): Promise<Omit<WorkerReply, 'id'>> {
  switch (request.op) {
    case 'tryAcquire': {
      const acquired = await lock.tryAcquire(request.key, { ttl: request.ttl, renew: request.renew })
      if (acquired === undefined) {
        return { acquired: false }
      }
      held.set(request.key, acquired)
      return { acquired: true, fencingToken: acquired.fencingToken }
    }
    case 'write': {
      // Writes with the token this worker holds, whether or not its lease is still good: a stale holder does not
      // know it is stale, and the resource is what must turn it away.
      const acquired = heldLock(request.key)
      return { accepted: await fencedWrite(client, request.key, acquired.fencingToken, request.value) }
    }
    case 'status': {
      const acquired = heldLock(request.key)
      const reason = acquired.signal.reason as { code?: string; reason?: string } | undefined
      return {
        lost: acquired.lost,
        signalReason: acquired.signal.aborted ? { code: String(reason?.code), reason: reason?.reason } : undefined,
      }
    }
    case 'release': {
      await heldLock(request.key).release()
      held.delete(request.key)
      return {}
    }
    case 'close': {
      await app.close()
      client.destroy()
      return {}
    }
  }
}

process.on('message', (request: WorkerRequest) => {
  handle(request).then(
    reply => {
      process.send?.({ ...reply, id: request.id })
      if (request.op === 'close') {
        process.disconnect?.()
      }
    },
    (error: unknown) => process.send?.({ id: request.id, error: String(error) }),
  )
})

process.send?.({ event: 'ready' })
