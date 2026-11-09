import { fork } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

import type { WorkerReply, WorkerRequest } from './worker.js'

// Omits `id` from each request on its own, so the union stays a union.
type WithoutID<T> = T extends unknown ? Omit<T, 'id'> : never
type Request = WithoutID<WorkerRequest>

/** A lock service running in a child process. */
export interface Worker {
  /** Sends one request and resolves its reply; rejects with the error the worker reported. */
  request(op: Request): Promise<WorkerReply>
  /** Stops the process where it stands, as a long pause or a frozen VM would. */
  pause(): void
  resume(): void
  /** Closes the worker's application and waits for the process to exit. */
  close(): Promise<void>
}

const WORKER = fileURLToPath(new URL('./worker.ts', import.meta.url))

async function startWorker(env: Record<string, string>): Promise<Worker> {
  const child = fork(WORKER, [], { execArgv: ['--import', 'tsx'], env: { ...process.env, ...env } })
  const pending = new Map<number, { resolve: (reply: WorkerReply) => void; reject: (error: Error) => void }>()
  let nextID = 0

  const ready = new Promise<void>((resolve, reject) => {
    child.once('exit', code => reject(new Error(`distlock worker exited with ${code} before it was ready`)))
    child.on('message', (message: WorkerReply & { event?: string }) => {
      if (message.event === 'ready') {
        resolve()
        return
      }

      const waiter = pending.get(message.id)
      pending.delete(message.id)
      if (message.error === undefined) {
        waiter?.resolve(message)
      } else {
        waiter?.reject(new Error(message.error))
      }
    })
  })
  await ready

  const exited = once(child, 'exit')
  // A worker that dies fails what it was asked, rather than leaving the spec to its timeout.
  child.once('exit', code => {
    for (const waiter of pending.values()) {
      waiter.reject(new Error(`distlock worker exited with ${code}`))
    }
    pending.clear()
  })

  function request(op: Request): Promise<WorkerReply> {
    const id = ++nextID
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      child.send({ ...op, id })
    })
  }

  return {
    request,
    pause: () => child.kill('SIGSTOP'),
    resume: () => child.kill('SIGCONT'),
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) {
        return
      }
      child.kill('SIGCONT')
      await request({ op: 'close' })
      await exited
    },
  }
}

/** Starts `n` workers against the lock server at `url`, each with its own connection, and waits until all are ready. */
export function startWorkers(n: number, url: string): Promise<Worker[]> {
  return Promise.all(Array.from({ length: n }, () => startWorker({ DISTLOCK_URL: url })))
}
