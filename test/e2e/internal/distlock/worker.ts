import { setTimeout as sleep } from 'node:timers/promises'

// A lock service in a process of its own, driven over IPC by `cluster.ts`, so a spec can stop and resume a
// holder the way an operating system or an orchestrator would.
import { createApplication } from '@caffeinejs/application'
import { CaffeineIoC } from '@caffeinejs/di'
import { DistributedLock, kDistLock, type Campaign, type Lock } from '@caffeinejs/distlock'
import { DistLockAOP, LeaderOnly, OneAtATime } from '@caffeinejs/distlock/aop'
import { RedisLockBackend } from '@caffeinejs/distlock/backend/redis'
import { createClient } from '@redis/client'

import { fencedWrite } from './fenced_resource.js'

export type WorkerRequest =
  | { op: 'tryAcquire'; id: number; key: string; ttl: number; renew: boolean }
  | { op: 'write'; id: number; key: string; value: string }
  | { op: 'status'; id: number; key: string }
  | { op: 'release'; id: number; key: string }
  | { op: 'campaign'; id: number; key: string; ttl: number }
  | { op: 'leading'; id: number; key: string }
  | { op: 'job'; id: number; kind: 'leaderOnly' | 'oneAtATime'; every: number; body: number; duration: number }
  | { op: 'close'; id: number }

export interface WorkerReply {
  id: number
  acquired?: boolean
  fencingToken?: number
  accepted?: boolean
  lost?: boolean
  signalReason?: { code: string; reason?: string }
  /** Whether this worker's campaign leads now, and how many times it was elected so far. */
  leader?: boolean
  elected?: number
  /** The runs a `job` request made, by this process's clock, and how many of its calls were skipped. */
  runs?: Array<{ enter: number; exit: number }>
  skipped?: number
  error?: string
}

const url = process.env.DISTLOCK_URL
if (url === undefined) {
  throw new Error('Cannot start the distlock worker: DISTLOCK_URL is not set')
}

const client = createClient({ url })
await client.connect()

// The decorated jobs lock on keys under the one the spec names, which a decorator takes when the class is defined.
// Each job has its own: every replica campaigns for the owned job's key from bootstrap.
const jobKey = process.env.DISTLOCK_JOB_KEY ?? 'caffeine:distlock:e2e:job'
let body = 0
const runs: Array<{ enter: number; exit: number }> = []

async function work(): Promise<void> {
  const enter = Date.now()
  await sleep(body)
  runs.push({ enter, exit: Date.now() })
}

class OwnedJob {
  @LeaderOnly(`${jobKey}:owned`)
  async run(): Promise<boolean | undefined> {
    await work()
    return true
  }
}

class ExclusiveJob {
  @OneAtATime(`${jobKey}:exclusive`)
  async run(): Promise<boolean | undefined> {
    await work()
    return true
  }
}

const app = createApplication({ container: new CaffeineIoC({ decorators: false }) })
  .install(DistributedLock(d => d.backend(new RedisLockBackend(client))))
  .install(DistLockAOP())
app.container.bind(OwnedJob, t => t.toSelf())
app.container.bind(ExclusiveJob, t => t.toSelf())
await app.bootstrap()
const lock = app.container.get(kDistLock)

const held = new Map<string, Lock>()
const campaigns = new Map<string, { campaign: Campaign; readonly elected: number }>()

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
    case 'campaign': {
      let elected = 0
      const campaign = lock.campaign(request.key, { ttl: request.ttl, onElected: () => void (elected += 1) })
      campaigns.set(request.key, {
        campaign,
        get elected() {
          return elected
        },
      })
      return {}
    }
    case 'leading': {
      const entry = campaigns.get(request.key)
      if (entry === undefined) {
        throw new Error(`Cannot find a campaign for "${request.key}" in this worker: start one first`)
      }
      return { leader: entry.campaign.isLeader, elected: entry.elected }
    }
    case 'job': {
      // Calls the job every `every` ms for `duration` ms, then waits for the calls still running.
      const job = app.container.get(request.kind === 'leaderOnly' ? OwnedJob : ExclusiveJob)
      body = request.body
      runs.length = 0
      let skipped = 0
      const calls: Array<Promise<void>> = []
      const timer = setInterval(() => {
        calls.push(
          job.run().then(ran => {
            skipped += ran === true ? 0 : 1
          }),
        )
      }, request.every)
      await sleep(request.duration)
      clearInterval(timer)
      await Promise.all(calls)
      return { runs: [...runs], skipped }
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
